/**
 * The stock ledger and its costing (docs/accounting/inventory.md).
 *
 * Method: moving weighted average per item, across all locations, in base
 * currency. An issue takes value = total value × issued ÷ on hand, rounded
 * half-up to the base currency's minor units; issuing the last unit takes all
 * remaining value, so value is exactly zero when quantity is.
 *
 * Rules that prevent wrong costs rather than producing them:
 *  - Negative stock is refused: an issue may not exceed what is on hand at the
 *    location (nor across the item).
 *  - Movements are recorded in date order per item. A movement dated before
 *    the item's latest movement is refused; record it on or after that date
 *    (a backdated receipt would change the cost of issues already posted).
 *  - Corrections are new movements: a return at its original cost, a
 *    reversal of a void, an adjustment or a revaluation — never an edit.
 *
 * These functions write the stock side only and return the value moved; the
 * caller posts the matching ledger lines in the same transaction, so the
 * stock ledger and the inventory account move together.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { itemCosts, itemStock, stockMoves, type StockMoveKind } from "@/lib/db/schema/inventory";
import { inventoryLocations, items } from "@/lib/db/schema/ledger";
import type { Ctx } from "@/lib/context";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { Decimal, type DecimalInput } from "@/lib/money/decimal";
import { minorUnits } from "@/lib/money/currency";
import { assertIsoDate } from "@/lib/dates";

export type StockMove = typeof stockMoves.$inferSelect;

export interface MoveSource {
  sourceType?: string | null;
  sourceId?: string | null;
  sourceLineId?: string | null;
  journalEntryId?: string | null;
  reversesMoveId?: string | null;
  transferGroupId?: string | null;
  reason?: string | null;
}

interface CostState {
  qty: Decimal;
  value: Decimal;
  lastMoveDate: string | null;
}

async function lockItem(tx: Tx, ctx: Ctx, itemId: string) {
  const [item] = await tx.select().from(items).where(and(eq(items.orgId, ctx.orgId), eq(items.id, itemId)));
  if (!item) throw new NotFoundError("The item");
  if (item.kind !== "stock") throw new ValidationError(`${item.name} is not a stock item; it has no inventory.`, { itemId: "Not a stock item." });
  await tx.insert(itemCosts).values({ orgId: ctx.orgId, itemId }).onConflictDoNothing();
  const [cost] = await tx
    .select()
    .from(itemCosts)
    .where(and(eq(itemCosts.orgId, ctx.orgId), eq(itemCosts.itemId, itemId)))
    .for("update");
  const state: CostState = { qty: Decimal.from(cost!.qtyOnHand), value: Decimal.from(cost!.totalValue), lastMoveDate: cost!.lastMoveDate };
  return { item, state };
}

async function lockLocation(tx: Tx, ctx: Ctx, itemId: string, locationId: string) {
  const [loc] = await tx
    .select()
    .from(inventoryLocations)
    .where(and(eq(inventoryLocations.orgId, ctx.orgId), eq(inventoryLocations.id, locationId)));
  if (!loc) throw new NotFoundError("The stock location");
  await tx.insert(itemStock).values({ orgId: ctx.orgId, itemId, locationId }).onConflictDoNothing();
  const [row] = await tx
    .select()
    .from(itemStock)
    .where(and(eq(itemStock.orgId, ctx.orgId), eq(itemStock.itemId, itemId), eq(itemStock.locationId, locationId)))
    .for("update");
  return { loc, qty: Decimal.from(row!.qtyOnHand) };
}

function checkDateOrder(itemName: string, state: CostState, date: string) {
  if (state.lastMoveDate && date < state.lastMoveDate) {
    throw new ConflictError(
      `${itemName} already has stock movements dated ${state.lastMoveDate}. Stock is costed in date order, so this movement must be dated on or after ${state.lastMoveDate}.`,
      "stock_backdated",
      { lastMoveDate: state.lastMoveDate, date },
    );
  }
}

async function writeMove(
  tx: Tx,
  ctx: Ctx,
  args: { itemId: string; locationId: string; date: string; kind: StockMoveKind; qty: Decimal; value: Decimal; state: CostState; locQty: Decimal; source: MoveSource },
): Promise<StockMove> {
  const newQty = args.state.qty.add(args.qty);
  const newValue = args.state.value.add(args.value);
  const newLocQty = args.locQty.add(args.qty);
  if (newQty.isNegative() || newLocQty.isNegative()) throw new Error("negative stock reached writeMove");
  if (newQty.isZero() && !newValue.isZero()) throw new Error("value left with no quantity");
  const unitCostAfter = newQty.isZero() ? null : newValue.div(newQty, 8, "half_up").toString();
  const [move] = await tx
    .insert(stockMoves)
    .values({
      orgId: ctx.orgId,
      itemId: args.itemId,
      locationId: args.locationId,
      moveDate: args.date,
      kind: args.kind,
      quantity: args.qty.toString(),
      value: args.value.toString(),
      unitCostAfter,
      qtyOnHandAfter: newQty.toString(),
      valueAfter: newValue.toString(),
      sourceType: args.source.sourceType ?? null,
      sourceId: args.source.sourceId ?? null,
      sourceLineId: args.source.sourceLineId ?? null,
      journalEntryId: args.source.journalEntryId ?? null,
      reversesMoveId: args.source.reversesMoveId ?? null,
      transferGroupId: args.source.transferGroupId ?? null,
      reason: args.source.reason ?? null,
      createdBy: ctx.actor.userId,
    })
    .returning();
  await tx
    .update(itemCosts)
    .set({
      qtyOnHand: newQty.toString(),
      totalValue: newValue.toString(),
      lastMoveDate: args.date,
      moveCount: sql`${itemCosts.moveCount} + 1`,
      updatedAt: new Date(),
    })
    .where(and(eq(itemCosts.orgId, ctx.orgId), eq(itemCosts.itemId, args.itemId)));
  await tx
    .update(itemStock)
    .set({ qtyOnHand: newLocQty.toString() })
    .where(and(eq(itemStock.orgId, ctx.orgId), eq(itemStock.itemId, args.itemId), eq(itemStock.locationId, args.locationId)));
  args.state.qty = newQty;
  args.state.value = newValue;
  args.state.lastMoveDate = args.date;
  return move!;
}

function positiveQty(q: DecimalInput, label = "quantity"): Decimal {
  const d = Decimal.from(q);
  if (!d.isPositive()) throw new ValidationError(`The ${label} must be more than zero.`, { quantity: "Must be positive." });
  if (d.decimalPlaces > 6) throw new ValidationError("Quantities have at most 6 decimal places.", { quantity: "Too precise." });
  return d;
}

/** Stock in at a stated value (a receipt, opening stock, a return at its original cost, a found-stock adjustment). */
export async function receiveStock(
  tx: Tx,
  ctx: Ctx,
  args: { itemId: string; locationId: string; date: string; quantity: DecimalInput; value: DecimalInput; kind: Extract<StockMoveKind, "opening" | "receipt" | "sale_return" | "adjustment" | "transfer_in">; source?: MoveSource },
): Promise<StockMove> {
  assertIsoDate(args.date);
  const qty = positiveQty(args.quantity);
  const value = Decimal.from(args.value);
  const mu = minorUnits(ctx.org.baseCurrency);
  if (value.isNegative()) throw new ValidationError("Stock received cannot have a negative value.", { value: "Must not be negative." });
  if (value.decimalPlaces > mu) throw new ValidationError("The value has too many decimal places.", { value: "Round to the currency." });
  const { item, state } = await lockItem(tx, ctx, args.itemId);
  checkDateOrder(item.name, state, args.date);
  const { qty: locQty } = await lockLocation(tx, ctx, args.itemId, args.locationId);
  return writeMove(tx, ctx, { itemId: args.itemId, locationId: args.locationId, date: args.date, kind: args.kind, qty, value: value.rescale(mu), state, locQty, source: args.source ?? {} });
}

/** Stock out at average cost. Returns the move; its `value` is negative (the cost relieved). */
export async function issueStock(
  tx: Tx,
  ctx: Ctx,
  args: { itemId: string; locationId: string; date: string; quantity: DecimalInput; kind: Extract<StockMoveKind, "sale" | "purchase_return" | "adjustment" | "transfer_out">; source?: MoveSource; valueOverride?: DecimalInput | null },
): Promise<StockMove> {
  assertIsoDate(args.date);
  const qty = positiveQty(args.quantity);
  const mu = minorUnits(ctx.org.baseCurrency);
  const { item, state } = await lockItem(tx, ctx, args.itemId);
  checkDateOrder(item.name, state, args.date);
  const { loc, qty: locQty } = await lockLocation(tx, ctx, args.itemId, args.locationId);
  if (qty.gt(locQty)) {
    throw new ConflictError(
      `Only ${locQty.normalize().toString()} ${item.unit} of ${item.name} ${locQty.eq(1) ? "is" : "are"} on hand at ${loc.name}; ${qty.normalize().toString()} cannot be issued. Gideon Books does not allow negative stock — record the receipt first.`,
      "insufficient_stock",
      { onHand: locQty.toString(), requested: qty.toString(), locationId: loc.id },
    );
  }
  if (qty.gt(state.qty)) throw new ConflictError(`Only ${state.qty.normalize().toString()} of ${item.name} are on hand.`, "insufficient_stock");
  let value: Decimal;
  if (args.valueOverride != null) {
    value = Decimal.from(args.valueOverride).abs().rescale(mu);
    if (value.gt(state.value)) throw new ConflictError("That value is more than the stock is carried at.", "value_exceeds_stock");
    if (qty.eq(state.qty) && !value.eq(state.value)) value = state.value;
  } else if (qty.eq(state.qty)) {
    value = state.value;
  } else {
    value = state.value.mulDiv(qty, state.qty, mu, "half_up");
  }
  return writeMove(tx, ctx, { itemId: args.itemId, locationId: args.locationId, date: args.date, kind: args.kind, qty: qty.neg(), value: value.neg(), state, locQty, source: args.source ?? {} });
}

/** Move stock between locations at average cost. No ledger effect: value stays in the item. */
export async function transferStock(
  tx: Tx,
  ctx: Ctx,
  args: { itemId: string; fromLocationId: string; toLocationId: string; date: string; quantity: DecimalInput; source?: MoveSource },
): Promise<{ out: StockMove; in: StockMove }> {
  if (args.fromLocationId === args.toLocationId) throw new ValidationError("Pick two different locations.", { toLocationId: "Same as the source." });
  const groupId = crypto.randomUUID();
  const out = await issueStock(tx, ctx, {
    itemId: args.itemId,
    locationId: args.fromLocationId,
    date: args.date,
    quantity: args.quantity,
    kind: "transfer_out",
    source: { ...args.source, transferGroupId: groupId },
  });
  const inn = await receiveStock(tx, ctx, {
    itemId: args.itemId,
    locationId: args.toLocationId,
    date: args.date,
    quantity: args.quantity,
    value: Decimal.from(out.value).neg().toString(),
    kind: "transfer_in",
    source: { ...args.source, transferGroupId: groupId },
  });
  return { out, in: inn };
}

/** Change the carrying value without changing quantity (a write-down, a landed-cost addition). */
export async function revalueStock(
  tx: Tx,
  ctx: Ctx,
  args: { itemId: string; locationId: string; date: string; valueChange: DecimalInput; source?: MoveSource },
): Promise<StockMove> {
  assertIsoDate(args.date);
  const mu = minorUnits(ctx.org.baseCurrency);
  const change = Decimal.from(args.valueChange);
  if (change.isZero()) throw new ValidationError("Enter the change in value.", { valueChange: "Cannot be zero." });
  if (change.decimalPlaces > mu) throw new ValidationError("The value has too many decimal places.", { valueChange: "Round to the currency." });
  const { item, state } = await lockItem(tx, ctx, args.itemId);
  checkDateOrder(item.name, state, args.date);
  if (state.qty.isZero()) throw new ConflictError(`${item.name} has no stock on hand to revalue.`, "no_stock");
  if (state.value.add(change).isNegative()) throw new ConflictError("Stock cannot be carried at a negative value.", "negative_value");
  const { qty: locQty } = await lockLocation(tx, ctx, args.itemId, args.locationId);
  return writeMove(tx, ctx, { itemId: args.itemId, locationId: args.locationId, date: args.date, kind: "revaluation", qty: Decimal.ZERO, value: change.rescale(mu), state, locQty, source: args.source ?? {} });
}

/** Undo a move (a voided invoice or bill): the opposite quantity at the original value, dated `date`. */
export async function reverseMove(tx: Tx, ctx: Ctx, move: StockMove, date: string, source: MoveSource = {}): Promise<StockMove> {
  const qty = Decimal.from(move.quantity);
  const value = Decimal.from(move.value);
  const src = { ...source, reversesMoveId: move.id, sourceType: source.sourceType ?? move.sourceType, sourceId: source.sourceId ?? move.sourceId, sourceLineId: move.sourceLineId };
  if (qty.isNegative()) {
    // The original took stock out; put it back at the value it left at.
    return receiveStock(tx, ctx, {
      itemId: move.itemId,
      locationId: move.locationId,
      date,
      quantity: qty.neg().toString(),
      value: value.neg().toString(),
      kind: move.kind === "sale" ? "sale_return" : "adjustment",
      source: src,
    });
  }
  if (qty.isPositive()) {
    // The original brought stock in; take the same quantity out at its original value.
    return issueStock(tx, ctx, {
      itemId: move.itemId,
      locationId: move.locationId,
      date,
      quantity: qty.toString(),
      kind: move.kind === "receipt" ? "purchase_return" : "adjustment",
      source: src,
      valueOverride: value.toString(),
    });
  }
  return revalueStock(tx, ctx, { itemId: move.itemId, locationId: move.locationId, date, valueChange: value.neg().toString(), source: src });
}

export async function defaultLocationId(tx: Tx, ctx: Ctx): Promise<string> {
  const [loc] = await tx
    .select({ id: inventoryLocations.id })
    .from(inventoryLocations)
    .where(and(eq(inventoryLocations.orgId, ctx.orgId), eq(inventoryLocations.isDefault, true)))
    .limit(1);
  if (loc) return loc.id;
  const [created] = await tx
    .insert(inventoryLocations)
    .values({ orgId: ctx.orgId, code: "MAIN", name: "Main", isDefault: true })
    .onConflictDoNothing()
    .returning({ id: inventoryLocations.id });
  if (created) return created.id;
  const [again] = await tx
    .select({ id: inventoryLocations.id })
    .from(inventoryLocations)
    .where(and(eq(inventoryLocations.orgId, ctx.orgId), eq(inventoryLocations.isDefault, true)))
    .limit(1);
  return again!.id;
}
