/**
 * Products and services. A stock item is counted and costed (lib/inventory);
 * a non-stock item is bought or sold without inventory; a service is labor
 * or a fee.
 */
import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { withTransaction, type DbOrTx } from "@/lib/db/client";
import { accounts, items } from "@/lib/db/schema/ledger";
import { stockMoves } from "@/lib/db/schema/inventory";
import { audit } from "@/lib/audit";
import { requirePermission, type Ctx } from "@/lib/context";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { Decimal } from "@/lib/money/decimal";
import { systemAccountId } from "@/lib/ledger/accounts";

export type Item = typeof items.$inferSelect;

export interface ItemInput {
  kind: Item["kind"];
  sku?: string | null;
  name: string;
  description?: string | null;
  unit?: string | null;
  salePrice?: string | null;
  purchaseCost?: string | null;
  incomeAccountId?: string | null;
  expenseAccountId?: string | null;
  inventoryAccountId?: string | null;
  saleTaxCodeId?: string | null;
  purchaseTaxCodeId?: string | null;
  reorderLevel?: string | null;
  reorderQuantity?: string | null;
  preferredVendorId?: string | null;
}

function dec(v: string | null | undefined, field: string, fields: Record<string, string>, opts: { nonNegative?: boolean } = {}): string | null {
  if (v === null || v === undefined || v.trim() === "") return null;
  const d = Decimal.tryFrom(v.replace(/,/g, "").trim());
  if (!d) {
    fields[field] = "Not a number.";
    return null;
  }
  if (opts.nonNegative && d.isNegative()) {
    fields[field] = "Cannot be negative.";
    return null;
  }
  if (d.decimalPlaces > 8) {
    fields[field] = "At most 8 decimal places.";
    return null;
  }
  return d.toString();
}

async function normalize(ctx: Ctx, input: ItemInput) {
  const fields: Record<string, string> = {};
  if (!["service", "non_stock", "stock"].includes(input.kind)) fields.kind = "Choose a kind.";
  if (!input.name?.trim()) fields.name = "Enter a name.";
  const salePrice = dec(input.salePrice, "salePrice", fields, { nonNegative: true });
  const purchaseCost = dec(input.purchaseCost, "purchaseCost", fields, { nonNegative: true });
  const reorderLevel = dec(input.reorderLevel, "reorderLevel", fields, { nonNegative: true });
  const reorderQuantity = dec(input.reorderQuantity, "reorderQuantity", fields, { nonNegative: true });
  if (Object.keys(fields).length) throw new ValidationError("Check the item.", fields);
  return { salePrice, purchaseCost, reorderLevel, reorderQuantity };
}

async function checkAccounts(tx: DbOrTx, ctx: Ctx, input: ItemInput & { incomeAccountId: string | null; expenseAccountId: string | null; inventoryAccountId: string | null }) {
  const ids = [input.incomeAccountId, input.expenseAccountId, input.inventoryAccountId].filter(Boolean) as string[];
  if (!ids.length) return;
  const rows = await tx.select().from(accounts).where(and(eq(accounts.orgId, ctx.orgId), inArray(accounts.id, ids)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const fields: Record<string, string> = {};
  if (input.incomeAccountId && byId.get(input.incomeAccountId)?.type !== "income") fields.incomeAccountId = "Pick an income account.";
  if (input.kind === "stock") {
    const inv = input.inventoryAccountId ? byId.get(input.inventoryAccountId) : null;
    if (!inv || inv.control !== "inventory") fields.inventoryAccountId = "Pick an inventory asset account.";
    const cogs = input.expenseAccountId ? byId.get(input.expenseAccountId) : null;
    if (!cogs || cogs.type !== "expense") fields.expenseAccountId = "Pick a cost of goods sold account.";
  } else if (input.expenseAccountId) {
    const e = byId.get(input.expenseAccountId);
    if (!e || !["expense", "asset"].includes(e.type)) fields.expenseAccountId = "Pick an expense or asset account.";
  }
  if (Object.keys(fields).length) throw new ValidationError("Check the item's accounts.", fields);
}

export async function createItem(ctx: Ctx, input: ItemInput): Promise<Item> {
  requirePermission(ctx, "items.manage");
  const n = await normalize(ctx, input);
  return withTransaction(async (tx) => {
    let incomeAccountId = input.incomeAccountId || null;
    let expenseAccountId = input.expenseAccountId || null;
    let inventoryAccountId = input.inventoryAccountId || null;
    if (!incomeAccountId) incomeAccountId = await systemAccountId(tx, ctx.orgId, input.kind === "service" ? "service_income" : "sales_income");
    if (input.kind === "stock") {
      inventoryAccountId ??= await systemAccountId(tx, ctx.orgId, "inventory_asset");
      expenseAccountId ??= await systemAccountId(tx, ctx.orgId, "cost_of_goods_sold");
    }
    await checkAccounts(tx, ctx, { ...input, incomeAccountId, expenseAccountId, inventoryAccountId });
    if (input.sku?.trim()) {
      const [clash] = await tx.select({ id: items.id }).from(items).where(and(eq(items.orgId, ctx.orgId), eq(items.sku, input.sku.trim())));
      if (clash) throw new ValidationError("That SKU is taken.", { sku: "Another item uses it." });
    }
    const [row] = await tx
      .insert(items)
      .values({
        orgId: ctx.orgId,
        kind: input.kind,
        sku: input.sku?.trim() || null,
        name: input.name.trim(),
        description: input.description?.trim() || null,
        unit: input.unit?.trim() || "ea",
        salePrice: n.salePrice,
        purchaseCost: n.purchaseCost,
        incomeAccountId,
        expenseAccountId,
        inventoryAccountId: input.kind === "stock" ? inventoryAccountId : null,
        saleTaxCodeId: input.saleTaxCodeId || null,
        purchaseTaxCodeId: input.purchaseTaxCodeId || null,
        reorderLevel: n.reorderLevel,
        reorderQuantity: n.reorderQuantity,
        preferredVendorId: input.preferredVendorId || null,
      })
      .returning();
    await audit(tx, ctx, { action: "item.created", entityType: "item", entityId: row!.id, after: row });
    return row!;
  });
}

export async function updateItem(ctx: Ctx, id: string, input: ItemInput): Promise<Item> {
  requirePermission(ctx, "items.manage");
  const n = await normalize(ctx, input);
  return withTransaction(async (tx) => {
    const before = await getItem(tx, ctx.orgId, id);
    const [moved] = await tx.select({ n: sql<number>`count(*)::int` }).from(stockMoves).where(and(eq(stockMoves.orgId, ctx.orgId), eq(stockMoves.itemId, id)));
    const hasMoves = (moved?.n ?? 0) > 0;
    if (hasMoves && input.kind !== before.kind) {
      throw new ConflictError("This item has stock movements, so it stays a stock item. Archive it and create a new item instead.", "item_has_stock");
    }
    if (hasMoves && (input.inventoryAccountId || before.inventoryAccountId) !== before.inventoryAccountId) {
      throw new ConflictError("The inventory account of an item with stock cannot change; its value is in the current account.", "item_has_stock");
    }
    const incomeAccountId = input.incomeAccountId || before.incomeAccountId;
    const expenseAccountId = input.expenseAccountId || before.expenseAccountId;
    const inventoryAccountId = input.kind === "stock" ? input.inventoryAccountId || before.inventoryAccountId : null;
    await checkAccounts(tx, ctx, { ...input, incomeAccountId, expenseAccountId, inventoryAccountId });
    if (input.sku?.trim()) {
      const [clash] = await tx.select({ id: items.id }).from(items).where(and(eq(items.orgId, ctx.orgId), eq(items.sku, input.sku.trim())));
      if (clash && clash.id !== id) throw new ValidationError("That SKU is taken.", { sku: "Another item uses it." });
    }
    const [row] = await tx
      .update(items)
      .set({
        kind: input.kind,
        sku: input.sku?.trim() || null,
        name: input.name.trim(),
        description: input.description?.trim() || null,
        unit: input.unit?.trim() || "ea",
        salePrice: n.salePrice,
        purchaseCost: n.purchaseCost,
        incomeAccountId,
        expenseAccountId,
        inventoryAccountId,
        saleTaxCodeId: input.saleTaxCodeId || null,
        purchaseTaxCodeId: input.purchaseTaxCodeId || null,
        reorderLevel: n.reorderLevel,
        reorderQuantity: n.reorderQuantity,
        preferredVendorId: input.preferredVendorId || null,
        updatedAt: new Date(),
      })
      .where(and(eq(items.orgId, ctx.orgId), eq(items.id, id)))
      .returning();
    await audit(tx, ctx, { action: "item.updated", entityType: "item", entityId: id, before, after: row });
    return row!;
  });
}

export async function setItemArchived(ctx: Ctx, id: string, archived: boolean) {
  requirePermission(ctx, "items.manage");
  await withTransaction(async (tx) => {
    await getItem(tx, ctx.orgId, id);
    await tx.update(items).set({ isArchived: archived, updatedAt: new Date() }).where(and(eq(items.orgId, ctx.orgId), eq(items.id, id)));
    await audit(tx, ctx, { action: archived ? "item.archived" : "item.restored", entityType: "item", entityId: id });
  });
}

export async function getItem(db: DbOrTx, orgId: string, id: string): Promise<Item> {
  const [i] = await db.select().from(items).where(and(eq(items.orgId, orgId), eq(items.id, id))).limit(1);
  if (!i) throw new NotFoundError("The item");
  return i;
}

export async function listItems(
  db: DbOrTx,
  orgId: string,
  f: { q?: string; kind?: Item["kind"]; includeArchived?: boolean; page?: number; pageSize?: number; sort?: "name_asc" | "name_desc" | "sku_asc" } = {},
) {
  const conds: SQL[] = [eq(items.orgId, orgId)];
  if (!f.includeArchived) conds.push(eq(items.isArchived, false));
  if (f.kind) conds.push(eq(items.kind, f.kind));
  if (f.q) {
    const like = `%${f.q.replace(/[%_]/g, "\\$&")}%`;
    conds.push(or(ilike(items.name, like), ilike(items.sku, like), ilike(items.description, like))!);
  }
  const pageSize = Math.min(Math.max(f.pageSize ?? 50, 1), 500);
  const page = Math.max(f.page ?? 1, 1);
  const order = f.sort === "name_desc" ? desc(items.name) : f.sort === "sku_asc" ? asc(items.sku) : asc(items.name);
  const where = and(...conds);
  const [rows, [count]] = await Promise.all([
    db.select().from(items).where(where).orderBy(order).limit(pageSize).offset((page - 1) * pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(items).where(where),
  ]);
  return { rows, total: count?.n ?? 0, page, pageSize };
}
