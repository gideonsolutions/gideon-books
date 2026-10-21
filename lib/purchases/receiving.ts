/**
 * Receiving goods against a purchase order, ahead of the vendor's bill.
 *
 * Stock lines come into stock at the order's net price (converted at the
 * receipt date's rate) and are carried in Goods Received Not Invoiced until
 * the bill arrives (matching.ts). Non-stock lines just record the quantity
 * received. Receiving more than was ordered is refused. A receipt can be
 * reversed while none of it has been billed and the stock is still there.
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { withTransaction, type DbOrTx } from "@/lib/db/client";
import { documentLines, documents } from "@/lib/db/schema/commerce";
import { items, inventoryLocations } from "@/lib/db/schema/ledger";
import { stockMoves } from "@/lib/db/schema/inventory";
import { poBillMatches, poClosures, purchaseReceiptLines, purchaseReceipts } from "@/lib/db/schema/purchasing";
import { audit } from "@/lib/audit";
import { requirePermission, type Ctx } from "@/lib/context";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { Decimal } from "@/lib/money/decimal";
import { minorUnits } from "@/lib/money/currency";
import { assertIsoDate, isIsoDate } from "@/lib/dates";
import { resolveRate } from "@/lib/fx/rates";
import { postEntry, reverseEntryInternal, type LineInput } from "@/lib/ledger/posting";
import { systemAccountId } from "@/lib/ledger/accounts";
import { nextNumber } from "@/lib/ledger/sequences";
import { defaultLocationId, receiveStock, reverseMove } from "@/lib/inventory/stock";
import { refreshPoStatus, unbilledReceived } from "./matching";

export type PurchaseReceipt = typeof purchaseReceipts.$inferSelect;

export interface ReceiveInput {
  date: string;
  locationId?: string | null;
  memo?: string | null;
  lines: { poLineId: string; quantity: string }[];
}

export async function receivePurchaseOrder(ctx: Ctx, poId: string, input: ReceiveInput): Promise<PurchaseReceipt> {
  requirePermission(ctx, "purchases.manage");
  if (!isIsoDate(input.date)) throw new ValidationError("Enter the date the goods arrived.", { date: "Required." });
  const wanted = input.lines
    .map((l) => ({ poLineId: l.poLineId, qty: Decimal.tryFrom((l.quantity ?? "").replace(/,/g, "").trim() || "0") }))
    .filter((l) => l.qty === null || !l.qty.isZero());
  const fields: Record<string, string> = {};
  wanted.forEach((l, i) => {
    if (!l.qty) fields[`lines.${i}.quantity`] = "Not a number.";
    else if (l.qty.isNegative()) fields[`lines.${i}.quantity`] = "Receive a positive quantity; reverse a receipt to take goods back.";
    else if (l.qty.decimalPlaces > 6) fields[`lines.${i}.quantity`] = "At most 6 decimal places.";
  });
  if (Object.keys(fields).length) throw new ValidationError("Check the quantities.", fields);
  if (!wanted.length) throw new ValidationError("Enter a quantity received on at least one line.");

  return withTransaction(async (tx) => {
    const [po] = await tx
      .select()
      .from(documents)
      .where(and(eq(documents.orgId, ctx.orgId), eq(documents.id, poId)))
      .for("update");
    if (!po || po.kind !== "purchase_order") throw new NotFoundError("The purchase order");
    if (!["issued", "partially_received", "received"].includes(po.status)) {
      throw new ConflictError(`Purchase order ${po.number ?? ""} is ${po.status}; only an issued order can be received.`, "po_not_open");
    }
    const lines = await tx
      .select()
      .from(documentLines)
      .where(and(eq(documentLines.orgId, ctx.orgId), eq(documentLines.documentId, poId)))
      .orderBy(asc(documentLines.lineNo));
    const locationId = input.locationId || po.inventoryLocationId || (await defaultLocationId(tx, ctx));
    const [loc] = await tx
      .select()
      .from(inventoryLocations)
      .where(and(eq(inventoryLocations.orgId, ctx.orgId), eq(inventoryLocations.id, locationId)));
    if (!loc) throw new ValidationError("That stock location does not exist.", { locationId: "Not found." });
    const itemIds = [...new Set(lines.map((l) => l.itemId).filter(Boolean))] as string[];
    const itemRows = itemIds.length ? await tx.select().from(items).where(and(eq(items.orgId, ctx.orgId), inArray(items.id, itemIds))) : [];
    const itemMap = new Map(itemRows.map((i) => [i.id, i]));

    const base = ctx.org.baseCurrency;
    const baseMu = minorUnits(base);
    const rate = po.currency === base ? Decimal.ONE : (await resolveRate(tx, ctx, po.currency, input.date)).rate;
    const { formatted: number } = await nextNumber(tx, ctx.orgId, "purchase_receipt");
    const [receipt] = await tx
      .insert(purchaseReceipts)
      .values({ orgId: ctx.orgId, number, purchaseOrderId: poId, receiptDate: input.date, locationId, memo: input.memo?.trim() || null, createdBy: ctx.actor.userId })
      .returning();

    const ledger: LineInput[] = [];
    const moveIds: string[] = [];
    let grniTotal = Decimal.ZERO;
    for (const w of wanted) {
      const pl = lines.find((l) => l.id === w.poLineId);
      if (!pl) throw new ValidationError("A line does not belong to this purchase order.");
      const remaining = Decimal.from(pl.quantity).sub(pl.receivedQuantity);
      if (w.qty!.gt(remaining)) {
        throw new ConflictError(
          `Line ${pl.lineNo} (${pl.description}): ${remaining.normalize().toString()} remain to receive of ${Decimal.from(pl.quantity).normalize().toString()} ordered; ${w.qty!.normalize().toString()} cannot be received. Raise a new order for the extra.`,
          "over_receipt",
          { line: pl.lineNo, remaining: remaining.toString() },
        );
      }
      const item = pl.itemId ? itemMap.get(pl.itemId) : null;
      let value = Decimal.ZERO;
      let moveId: string | null = null;
      if (item?.kind === "stock") {
        // The order's net price per unit (after discounts), in base at the receipt date's rate.
        value = Decimal.from(pl.netAmount).mul(w.qty!).mul(rate).div(pl.quantity, baseMu, "half_up");
        const move = await receiveStock(tx, ctx, {
          itemId: item.id,
          locationId: pl.inventoryLocationId ?? locationId,
          date: input.date,
          quantity: w.qty!.toString(),
          value: value.toString(),
          kind: "receipt",
          source: { sourceType: "purchase_receipt", sourceId: receipt!.id, sourceLineId: pl.id },
        });
        moveId = move.id;
        moveIds.push(move.id);
        if (!value.isZero()) {
          ledger.push({ accountId: item.inventoryAccountId!, amount: value.toString(), itemId: item.id, quantity: w.qty!.toString(), description: `${item.name} received (${po.number})`, contactId: po.contactId, sourceLineId: pl.id });
          grniTotal = grniTotal.add(value);
        }
      }
      await tx.insert(purchaseReceiptLines).values({
        orgId: ctx.orgId,
        receiptId: receipt!.id,
        poLineId: pl.id,
        itemId: pl.itemId,
        quantity: w.qty!.toString(),
        value: value.toString(),
        stockMoveId: moveId,
      });
      await tx
        .update(documentLines)
        .set({ receivedQuantity: sql`${documentLines.receivedQuantity} + ${w.qty!.toString()}` })
        .where(and(eq(documentLines.orgId, ctx.orgId), eq(documentLines.id, pl.id)));
    }
    let journalEntryId: string | null = null;
    if (!grniTotal.isZero()) {
      ledger.push({
        accountId: await systemAccountId(tx, ctx.orgId, "goods_received_not_invoiced"),
        amount: grniTotal.neg().toString(),
        description: `Goods received not invoiced — ${po.number}`,
        contactId: po.contactId,
      });
      const posted = await postEntry(tx, ctx, {
        kind: "inventory",
        entryDate: input.date,
        description: `Goods received ${number} against purchase order ${po.number}`,
        sourceType: "purchase_receipt",
        sourceId: receipt!.id,
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
    const [row] = await tx.update(purchaseReceipts).set({ journalEntryId }).where(eq(purchaseReceipts.id, receipt!.id)).returning();
    await refreshPoStatus(tx, ctx, poId);
    await audit(tx, ctx, {
      action: "purchase_order.received",
      entityType: "document",
      entityId: poId,
      metadata: { receiptId: receipt!.id, number, lines: wanted.map((w) => ({ poLineId: w.poLineId, quantity: w.qty!.toString() })), grni: grniTotal.toString() },
    });
    return row!;
  });
}

/**
 * Reverse a receipt (goods sent back, or received by mistake). Refused once
 * any of it has been billed — use a vendor credit then — or if the stock has
 * already left.
 */
export async function reverseReceipt(ctx: Ctx, receiptId: string, opts: { date: string; reason: string }) {
  requirePermission(ctx, "purchases.manage");
  assertIsoDate(opts.date, "reversal date");
  if (!opts.reason?.trim()) throw new ValidationError("Say why the receipt is being reversed.", { reason: "Required." });
  return withTransaction(async (tx) => {
    const [r] = await tx
      .select()
      .from(purchaseReceipts)
      .where(and(eq(purchaseReceipts.orgId, ctx.orgId), eq(purchaseReceipts.id, receiptId)))
      .for("update");
    if (!r) throw new NotFoundError("The receipt");
    if (r.status === "reversed") throw new ConflictError("This receipt was already reversed.", "already_reversed");
    await tx
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.orgId, ctx.orgId), eq(documents.id, r.purchaseOrderId)))
      .for("update");
    const date = opts.date < r.receiptDate ? r.receiptDate : opts.date;
    const rlines = await tx.select().from(purchaseReceiptLines).where(and(eq(purchaseReceiptLines.orgId, ctx.orgId), eq(purchaseReceiptLines.receiptId, receiptId)));
    for (const l of rlines) {
      const un = await unbilledReceived(tx, ctx.orgId, l.poLineId);
      if (un.qty.lt(l.quantity)) {
        throw new ConflictError("Part of this receipt has already been billed. Return the goods with a vendor credit instead.", "receipt_billed");
      }
    }
    for (const l of rlines) {
      if (l.stockMoveId) {
        const [m] = await tx.select().from(stockMoves).where(and(eq(stockMoves.orgId, ctx.orgId), eq(stockMoves.id, l.stockMoveId)));
        if (m) await reverseMove(tx, ctx, m, date, { sourceType: "purchase_receipt", sourceId: r.id, reason: opts.reason.trim() });
      }
      await tx
        .update(documentLines)
        .set({ receivedQuantity: sql`${documentLines.receivedQuantity} - ${l.quantity}` })
        .where(and(eq(documentLines.orgId, ctx.orgId), eq(documentLines.id, l.poLineId)));
    }
    let reversalEntryId: string | null = null;
    if (r.journalEntryId) {
      const rev = await reverseEntryInternal(tx, ctx, r.journalEntryId, { date, reason: `Receipt reversed: ${opts.reason.trim()}` });
      reversalEntryId = rev.entry.id;
    }
    await tx
      .update(purchaseReceipts)
      .set({ status: "reversed", reversedAt: new Date(), reversalEntryId, reversalReason: opts.reason.trim() })
      .where(eq(purchaseReceipts.id, r.id));
    await refreshPoStatus(tx, ctx, r.purchaseOrderId);
    await audit(tx, ctx, { action: "purchase_order.receipt_reversed", entityType: "document", entityId: r.purchaseOrderId, reason: opts.reason.trim(), metadata: { receiptId: r.id } });
  });
}

/** Close a purchase order by hand: nothing more will be received or billed against it. */
export async function closePurchaseOrder(ctx: Ctx, poId: string, reason: string) {
  requirePermission(ctx, "purchases.manage");
  if (!reason?.trim()) throw new ValidationError("Say why the order is being closed.", { reason: "Required." });
  return withTransaction(async (tx) => {
    const [po] = await tx.select().from(documents).where(and(eq(documents.orgId, ctx.orgId), eq(documents.id, poId))).for("update");
    if (!po || po.kind !== "purchase_order") throw new NotFoundError("The purchase order");
    if (!["issued", "partially_received", "received"].includes(po.status)) throw new ConflictError(`This order is ${po.status}.`, "po_not_open");
    await tx.insert(poClosures).values({ orgId: ctx.orgId, purchaseOrderId: poId, reason: reason.trim(), closedBy: ctx.actor.userId });
    await tx.update(documents).set({ status: "closed", updatedAt: new Date() }).where(eq(documents.id, poId));
    await audit(tx, ctx, { action: "purchase_order.closed", entityType: "document", entityId: poId, reason: reason.trim() });
  });
}

/** Reopen a hand-closed purchase order. */
export async function reopenPurchaseOrder(ctx: Ctx, poId: string) {
  requirePermission(ctx, "purchases.manage");
  return withTransaction(async (tx) => {
    const [po] = await tx.select().from(documents).where(and(eq(documents.orgId, ctx.orgId), eq(documents.id, poId))).for("update");
    if (!po || po.kind !== "purchase_order") throw new NotFoundError("The purchase order");
    const updated = await tx
      .update(poClosures)
      .set({ reopenedAt: new Date() })
      .where(and(eq(poClosures.orgId, ctx.orgId), eq(poClosures.purchaseOrderId, poId), sql`${poClosures.reopenedAt} is null`))
      .returning();
    if (!updated.length) throw new ConflictError("This order was not closed by hand.", "not_closed_manually");
    await tx.update(documents).set({ status: "issued", updatedAt: new Date() }).where(eq(documents.id, poId));
    await refreshPoStatus(tx, ctx, poId);
    await audit(tx, ctx, { action: "purchase_order.reopened", entityType: "document", entityId: poId });
  });
}

export async function receiptsForOrder(db: DbOrTx, orgId: string, poId: string) {
  const receipts = await db
    .select()
    .from(purchaseReceipts)
    .where(and(eq(purchaseReceipts.orgId, orgId), eq(purchaseReceipts.purchaseOrderId, poId)))
    .orderBy(desc(purchaseReceipts.receiptDate), desc(purchaseReceipts.number));
  const ids = receipts.map((r) => r.id);
  const lines = ids.length ? await db.select().from(purchaseReceiptLines).where(and(eq(purchaseReceiptLines.orgId, orgId), inArray(purchaseReceiptLines.receiptId, ids))) : [];
  return receipts.map((r) => ({ ...r, lines: lines.filter((l) => l.receiptId === r.id) }));
}

export async function matchesForOrder(db: DbOrTx, orgId: string, poId: string) {
  return db
    .select({ match: poBillMatches, billNumber: documents.number, billReference: documents.reference, billStatus: documents.status })
    .from(poBillMatches)
    .innerJoin(documentLines, and(eq(documentLines.orgId, poBillMatches.orgId), eq(documentLines.id, poBillMatches.poLineId)))
    .innerJoin(documents, and(eq(documents.orgId, poBillMatches.orgId), eq(documents.id, poBillMatches.billId)))
    .where(and(eq(poBillMatches.orgId, orgId), eq(documentLines.documentId, poId)))
    .orderBy(desc(poBillMatches.createdAt));
}

export async function matchesForBill(db: DbOrTx, orgId: string, billId: string) {
  return db
    .select()
    .from(poBillMatches)
    .where(and(eq(poBillMatches.orgId, orgId), eq(poBillMatches.billId, billId)));
}
