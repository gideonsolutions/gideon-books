/**
 * Stock movements made by hand: opening stock, quantity adjustments (counts,
 * shrinkage, damage, found stock), transfers between locations, and
 * revaluations. Each is a numbered record whose stock moves carry its id,
 * and — except transfers, which move no value — an entry against the
 * inventory account(s) posted in the same transaction.
 */
import { and, desc, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import { withTransaction, type DbOrTx } from "@/lib/db/client";
import { stockMoves, itemCosts } from "@/lib/db/schema/inventory";
import { accounts, inventoryLocations, items } from "@/lib/db/schema/ledger";
import { inventoryMovements } from "@/lib/db/schema/purchasing";
import { audit } from "@/lib/audit";
import { requirePermission, type Ctx } from "@/lib/context";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { Decimal } from "@/lib/money/decimal";
import { minorUnits } from "@/lib/money/currency";
import { isIsoDate } from "@/lib/dates";
import { postEntry, type LineInput } from "@/lib/ledger/posting";
import { systemAccountId } from "@/lib/ledger/accounts";
import { nextNumber } from "@/lib/ledger/sequences";
import { issueStock, receiveStock, revalueStock, transferStock } from "./stock";

export type InventoryMovement = typeof inventoryMovements.$inferSelect;
export type MovementKind = InventoryMovement["kind"];

export const MOVEMENT_LABELS: Record<MovementKind, string> = {
  opening: "Opening stock",
  adjustment: "Quantity adjustment",
  transfer: "Transfer",
  revaluation: "Revaluation",
};

export interface MovementLineInput {
  itemId: string;
  /** Opening/transfer: quantity (positive). Adjustment: change (+ found, − lost). */
  quantity?: string | null;
  /** Opening stock and positive adjustments: cost per unit (base currency). Blank on a positive adjustment: current average cost. */
  unitCost?: string | null;
  /** Revaluation: the change in value (+ up, − down). */
  valueChange?: string | null;
}

export interface MovementInput {
  kind: MovementKind;
  date: string;
  reason: string;
  locationId?: string | null;
  toLocationId?: string | null;
  /** Account the value change is booked against; defaults: opening balance equity (opening), inventory adjustments (others). */
  offsetAccountId?: string | null;
  lines: MovementLineInput[];
}

function dec(v: string | null | undefined): Decimal | null {
  if (v === null || v === undefined || v.trim() === "") return null;
  return Decimal.tryFrom(v.replace(/[,\s$]/g, ""));
}

export async function recordMovement(ctx: Ctx, input: MovementInput): Promise<InventoryMovement> {
  requirePermission(ctx, "inventory.manage");
  if (input.kind === "opening") requirePermission(ctx, "opening_balances.manage");
  const fields: Record<string, string> = {};
  if (!isIsoDate(input.date)) fields.date = "Enter the date.";
  if (!input.reason?.trim()) fields.reason = "Say why (a count, damage, opening balance…).";
  if (!input.locationId) fields.locationId = input.kind === "transfer" ? "Choose where the stock comes from." : "Choose the location.";
  if (input.kind === "transfer" && !input.toLocationId) fields.toLocationId = "Choose where it goes.";
  if (input.kind === "transfer" && input.toLocationId === input.locationId) fields.toLocationId = "Pick a different location.";
  const lines = input.lines.filter((l) => l.itemId);
  if (!lines.length) fields.lines = "Add at least one item.";
  lines.forEach((l, i) => {
    const q = dec(l.quantity);
    if (input.kind === "revaluation") {
      const v = dec(l.valueChange);
      if (!v || v.isZero()) fields[`lines.${i}.valueChange`] = "Enter the change in value.";
      return;
    }
    if (!q || q.isZero()) fields[`lines.${i}.quantity`] = "Enter a quantity.";
    else if (input.kind !== "adjustment" && q.isNegative()) fields[`lines.${i}.quantity`] = "Must be positive.";
    if (input.kind === "opening" && !dec(l.unitCost)) fields[`lines.${i}.unitCost`] = "Enter the cost per unit.";
    const c = dec(l.unitCost);
    if (l.unitCost && (!c || c.isNegative())) fields[`lines.${i}.unitCost`] = "Not a valid cost.";
  });
  if (Object.keys(fields).length) throw new ValidationError("Check the movement.", fields);

  return withTransaction(async (tx) => {
    const itemRows = await tx.select().from(items).where(and(eq(items.orgId, ctx.orgId), inArray(items.id, lines.map((l) => l.itemId))));
    const itemMap = new Map(itemRows.map((i) => [i.id, i]));
    for (const [i, l] of lines.entries()) {
      const it = itemMap.get(l.itemId);
      if (!it || it.kind !== "stock") throw new ValidationError(`Line ${i + 1}: choose a stock item.`, { [`lines.${i}.itemId`]: "Not a stock item." });
    }
    for (const locId of [input.locationId, input.toLocationId].filter(Boolean) as string[]) {
      const [loc] = await tx.select().from(inventoryLocations).where(and(eq(inventoryLocations.orgId, ctx.orgId), eq(inventoryLocations.id, locId)));
      if (!loc) throw new ValidationError("That location does not exist.");
    }
    let offsetAccountId: string | null = null;
    if (input.kind !== "transfer") {
      offsetAccountId = input.offsetAccountId || (await systemAccountId(tx, ctx.orgId, input.kind === "opening" ? "opening_balance_equity" : "inventory_adjustments"));
      const [acc] = await tx.select().from(accounts).where(and(eq(accounts.orgId, ctx.orgId), eq(accounts.id, offsetAccountId)));
      if (!acc || acc.isArchived) throw new ValidationError("Choose an active offset account.", { offsetAccountId: "Not available." });
      if (acc.control) throw new ValidationError(`${acc.name} is a control account; book the value change to an expense, income or equity account.`, { offsetAccountId: "Control account." });
    }
    const seqKey = input.kind === "transfer" ? "stock_transfer" : "stock_adjustment";
    const { formatted: number } = await nextNumber(tx, ctx.orgId, seqKey);
    const [mv] = await tx
      .insert(inventoryMovements)
      .values({
        orgId: ctx.orgId,
        number,
        kind: input.kind,
        movementDate: input.date,
        reason: input.reason.trim(),
        fromLocationId: input.locationId ?? null,
        toLocationId: input.kind === "transfer" ? (input.toLocationId ?? null) : null,
        offsetAccountId,
        createdBy: ctx.actor.userId,
      })
      .returning();
    const sourceType = input.kind === "transfer" ? "stock_transfer" : "stock_adjustment";
    const source = { sourceType, sourceId: mv!.id, reason: input.reason.trim() };
    const ledger: LineInput[] = [];
    const moveIds: string[] = [];
    const baseMu = minorUnits(ctx.org.baseCurrency);
    let offsetTotal = Decimal.ZERO;

    for (const l of lines) {
      const item = itemMap.get(l.itemId)!;
      const qty = dec(l.quantity);
      let value = Decimal.ZERO; // signed change in inventory value
      if (input.kind === "transfer") {
        const t = await transferStock(tx, ctx, { itemId: item.id, fromLocationId: input.locationId!, toLocationId: input.toLocationId!, date: input.date, quantity: qty!.toString(), source });
        moveIds.push(t.out.id, t.in.id);
        continue;
      }
      if (input.kind === "revaluation") {
        const change = dec(l.valueChange)!;
        const m = await revalueStock(tx, ctx, { itemId: item.id, locationId: input.locationId!, date: input.date, valueChange: change.toString(), source });
        moveIds.push(m.id);
        value = Decimal.from(m.value);
      } else if (qty!.isPositive()) {
        const unit = dec(l.unitCost);
        if (!unit) {
          const [c] = await tx.select().from(itemCosts).where(and(eq(itemCosts.orgId, ctx.orgId), eq(itemCosts.itemId, item.id)));
          const q = Decimal.from(c?.qtyOnHand ?? "0");
          if (q.isZero()) {
            throw new ValidationError(`${item.name} has no stock to take an average cost from; enter the cost per unit.`, { unitCost: "Required." });
          }
          value = Decimal.from(c!.totalValue).mulDiv(qty!, q, baseMu, "half_up");
        } else {
          value = unit.mul(qty!).round(baseMu, "half_up");
        }
        const m = await receiveStock(tx, ctx, {
          itemId: item.id,
          locationId: input.locationId!,
          date: input.date,
          quantity: qty!.toString(),
          value: value.toString(),
          kind: input.kind === "opening" ? "opening" : "adjustment",
          source,
        });
        moveIds.push(m.id);
      } else {
        const m = await issueStock(tx, ctx, { itemId: item.id, locationId: input.locationId!, date: input.date, quantity: qty!.neg().toString(), kind: "adjustment", source });
        moveIds.push(m.id);
        value = Decimal.from(m.value);
      }
      if (!value.isZero()) {
        ledger.push({
          accountId: item.inventoryAccountId!,
          amount: value.toString(),
          itemId: item.id,
          ...(qty ? { quantity: qty.toString() } : {}),
          description: `${MOVEMENT_LABELS[input.kind]}: ${item.name}`,
        });
        offsetTotal = offsetTotal.add(value);
      }
    }
    let journalEntryId: string | null = null;
    if (ledger.length) {
      ledger.push({ accountId: offsetAccountId!, amount: offsetTotal.neg().toString(), description: `${MOVEMENT_LABELS[input.kind]} ${number}: ${input.reason.trim()}`.slice(0, 300) });
      const posted = await postEntry(tx, ctx, {
        // Always "inventory": an opening-balance kind could be reversed by hand without its stock moves.
        kind: "inventory",
        entryDate: input.date,
        description: `${MOVEMENT_LABELS[input.kind]} ${number} — ${input.reason.trim()}`.slice(0, 1000),
        sourceType,
        sourceId: mv!.id,
        sourceRef: number,
        cashBasis: "as_is",
        allowControlAccounts: true,
        lines: ledger,
      });
      journalEntryId = posted.entry.id;
      await tx
        .update(stockMoves)
        .set({ journalEntryId })
        .where(and(eq(stockMoves.orgId, ctx.orgId), inArray(stockMoves.id, moveIds), sql`${stockMoves.journalEntryId} is null`));
    }
    const [row] = await tx.update(inventoryMovements).set({ journalEntryId }).where(eq(inventoryMovements.id, mv!.id)).returning();
    await audit(tx, ctx, {
      action: `inventory.${input.kind}`,
      entityType: "inventory_movement",
      entityId: mv!.id,
      reason: input.reason.trim(),
      metadata: { number, lines: lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity, unitCost: l.unitCost, valueChange: l.valueChange })), value: offsetTotal.toString() },
    });
    return row!;
  });
}

export async function getMovement(db: DbOrTx, orgId: string, id: string) {
  const [mv] = await db.select().from(inventoryMovements).where(and(eq(inventoryMovements.orgId, orgId), eq(inventoryMovements.id, id)));
  if (!mv) throw new NotFoundError("The stock movement");
  const moves = await db
    .select({ move: stockMoves, itemName: items.name, itemUnit: items.unit, locationName: inventoryLocations.name })
    .from(stockMoves)
    .innerJoin(items, and(eq(items.orgId, stockMoves.orgId), eq(items.id, stockMoves.itemId)))
    .innerJoin(inventoryLocations, and(eq(inventoryLocations.orgId, stockMoves.orgId), eq(inventoryLocations.id, stockMoves.locationId)))
    .where(and(eq(stockMoves.orgId, orgId), eq(stockMoves.sourceId, id)))
    .orderBy(stockMoves.seq);
  return { movement: mv, moves };
}

export interface MoveFilters {
  itemId?: string;
  locationId?: string;
  kind?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

/** The stock ledger: every move, newest first, with its item, location and source. */
export async function listStockMoves(db: DbOrTx, orgId: string, f: MoveFilters = {}) {
  const conds: SQL[] = [eq(stockMoves.orgId, orgId)];
  if (f.itemId) conds.push(eq(stockMoves.itemId, f.itemId));
  if (f.locationId) conds.push(eq(stockMoves.locationId, f.locationId));
  if (f.kind) conds.push(eq(stockMoves.kind, f.kind as never));
  if (f.from) conds.push(gte(stockMoves.moveDate, f.from));
  if (f.to) conds.push(lte(stockMoves.moveDate, f.to));
  const pageSize = Math.min(Math.max(f.pageSize ?? 50, 1), 500);
  const page = Math.max(f.page ?? 1, 1);
  const where = and(...conds);
  const [rows, [count]] = await Promise.all([
    db
      .select({ move: stockMoves, itemName: items.name, itemUnit: items.unit, locationName: inventoryLocations.name })
      .from(stockMoves)
      .innerJoin(items, and(eq(items.orgId, stockMoves.orgId), eq(items.id, stockMoves.itemId)))
      .innerJoin(inventoryLocations, and(eq(inventoryLocations.orgId, stockMoves.orgId), eq(inventoryLocations.id, stockMoves.locationId)))
      .where(where)
      .orderBy(desc(stockMoves.moveDate), desc(stockMoves.seq))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(stockMoves).where(where),
  ]);
  return { rows, total: count?.n ?? 0, page, pageSize };
}

export async function listMovements(db: DbOrTx, orgId: string, opts: { page?: number; pageSize?: number; kind?: MovementKind } = {}) {
  const conds: SQL[] = [eq(inventoryMovements.orgId, orgId)];
  if (opts.kind) conds.push(eq(inventoryMovements.kind, opts.kind));
  const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 500);
  const page = Math.max(opts.page ?? 1, 1);
  const where = and(...conds);
  const [rows, [count]] = await Promise.all([
    db.select().from(inventoryMovements).where(where).orderBy(desc(inventoryMovements.movementDate), desc(inventoryMovements.createdAt)).limit(pageSize).offset((page - 1) * pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(inventoryMovements).where(where),
  ]);
  return { rows, total: count?.n ?? 0, page, pageSize };
}
