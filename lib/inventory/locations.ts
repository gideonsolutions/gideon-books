/** Stock locations (warehouses, stores, vans). Exactly one is the default. */
import { and, asc, eq, sql } from "drizzle-orm";
import { withTransaction, type DbOrTx } from "@/lib/db/client";
import { inventoryLocations } from "@/lib/db/schema/ledger";
import { itemStock } from "@/lib/db/schema/inventory";
import { audit } from "@/lib/audit";
import { requirePermission, type Ctx } from "@/lib/context";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";

export type InventoryLocation = typeof inventoryLocations.$inferSelect;

export async function listLocations(db: DbOrTx, orgId: string, opts: { includeArchived?: boolean } = {}) {
  const conds = [eq(inventoryLocations.orgId, orgId)];
  if (!opts.includeArchived) conds.push(eq(inventoryLocations.isArchived, false));
  const rows = await db.select().from(inventoryLocations).where(and(...conds)).orderBy(asc(inventoryLocations.name));
  const counts = await db
    .select({ locationId: itemStock.locationId, items: sql<number>`count(*) filter (where ${itemStock.qtyOnHand} > 0)::int` })
    .from(itemStock)
    .where(eq(itemStock.orgId, orgId))
    .groupBy(itemStock.locationId);
  return rows.map((r) => ({ ...r, itemsInStock: counts.find((c) => c.locationId === r.id)?.items ?? 0 }));
}

export async function saveLocation(ctx: Ctx, input: { id?: string | null; code: string; name: string; isDefault?: boolean; isArchived?: boolean }) {
  requirePermission(ctx, "inventory.manage");
  const fields: Record<string, string> = {};
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$/.test(input.code?.trim() ?? "")) fields.code = "Use 1–20 letters, digits, dashes or underscores.";
  if (!input.name?.trim()) fields.name = "Enter a name.";
  if (Object.keys(fields).length) throw new ValidationError("Check the location.", fields);
  return withTransaction(async (tx) => {
    const [clash] = await tx
      .select({ id: inventoryLocations.id })
      .from(inventoryLocations)
      .where(and(eq(inventoryLocations.orgId, ctx.orgId), eq(inventoryLocations.code, input.code.trim())));
    if (clash && clash.id !== input.id) throw new ValidationError("That code is taken.", { code: "Another location uses it." });
    let before: InventoryLocation | undefined;
    if (input.id) {
      [before] = await tx.select().from(inventoryLocations).where(and(eq(inventoryLocations.orgId, ctx.orgId), eq(inventoryLocations.id, input.id)));
      if (!before) throw new NotFoundError("The location");
      if (input.isArchived && !before.isArchived) {
        const [held] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(itemStock)
          .where(and(eq(itemStock.orgId, ctx.orgId), eq(itemStock.locationId, input.id), sql`${itemStock.qtyOnHand} > 0`));
        if ((held?.n ?? 0) > 0) throw new ConflictError("Stock is still held here. Transfer it out before archiving the location.", "location_has_stock");
        if (before.isDefault) throw new ConflictError("Make another location the default first.", "default_location");
      }
      if (before.isDefault && input.isDefault === false) throw new ConflictError("Make another location the default instead; there is always one.", "default_location");
    }
    if (input.isDefault) {
      await tx.update(inventoryLocations).set({ isDefault: false }).where(and(eq(inventoryLocations.orgId, ctx.orgId), eq(inventoryLocations.isDefault, true)));
    }
    const values = {
      code: input.code.trim().toUpperCase(),
      name: input.name.trim(),
      isDefault: input.isDefault ?? before?.isDefault ?? false,
      isArchived: input.isArchived ?? before?.isArchived ?? false,
    };
    const [row] = input.id
      ? await tx.update(inventoryLocations).set(values).where(and(eq(inventoryLocations.orgId, ctx.orgId), eq(inventoryLocations.id, input.id))).returning()
      : await tx.insert(inventoryLocations).values({ orgId: ctx.orgId, ...values }).returning();
    await audit(tx, ctx, { action: input.id ? "inventory.location_updated" : "inventory.location_created", entityType: "inventory_location", entityId: row!.id, before, after: row });
    return row!;
  });
}
