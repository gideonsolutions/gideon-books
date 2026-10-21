/**
 * Three-way matching of bills to purchase orders and their receipts.
 *
 * Goods received against a purchase order sit in Goods Received Not
 * Invoiced (GRNI) at their received value until billed. When a bill line
 * comes from a purchase-order line (its `sourceLineId`):
 *  - the quantity that matches goods already received and not yet billed
 *    relieves GRNI at the value they were received at, and any difference
 *    between that value and what the bill charges goes to purchase price
 *    variance;
 *  - any further quantity is received with the bill itself (stock in at the
 *    bill's value, as for a bill without an order);
 *  - billing more than was ordered is refused unless the person confirms it.
 * Voiding the bill undoes its matches.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { documentLines, documents, type DocumentStatus } from "@/lib/db/schema/commerce";
import { items } from "@/lib/db/schema/ledger";
import { poBillMatches, poClosures, purchaseReceiptLines, purchaseReceipts } from "@/lib/db/schema/purchasing";
import type { Ctx } from "@/lib/context";
import { ConflictError, ValidationError } from "@/lib/errors";
import { Decimal } from "@/lib/money/decimal";
import { minorUnits } from "@/lib/money/currency";

export interface PoMatchPlan {
  poId: string;
  poLineId: string;
  billLineId: string;
  isStock: boolean;
  billedQty: Decimal;
  /** Quantity matched to earlier receipts. */
  matchedQty: Decimal;
  /** Quantity received with this bill. */
  receivedWithBill: Decimal;
  /** GRNI relieved, in base currency. */
  grniValue: Decimal;
}

/** Received-but-unbilled quantity and value of a purchase-order line, from its receipts and matches. */
export async function unbilledReceived(tx: Tx, orgId: string, poLineId: string): Promise<{ qty: Decimal; value: Decimal }> {
  const [rec] = await tx
    .select({
      qty: sql<string>`coalesce(sum(${purchaseReceiptLines.quantity}), 0)::text`,
      value: sql<string>`coalesce(sum(${purchaseReceiptLines.value}), 0)::text`,
    })
    .from(purchaseReceiptLines)
    .innerJoin(purchaseReceipts, and(eq(purchaseReceipts.id, purchaseReceiptLines.receiptId), eq(purchaseReceipts.orgId, purchaseReceiptLines.orgId)))
    .where(and(eq(purchaseReceiptLines.orgId, orgId), eq(purchaseReceiptLines.poLineId, poLineId), eq(purchaseReceipts.status, "posted")));
  const [m] = await tx
    .select({
      qty: sql<string>`coalesce(sum(${poBillMatches.matchedQuantity}), 0)::text`,
      value: sql<string>`coalesce(sum(${poBillMatches.grniValue}), 0)::text`,
    })
    .from(poBillMatches)
    .where(and(eq(poBillMatches.orgId, orgId), eq(poBillMatches.poLineId, poLineId), eq(poBillMatches.status, "active")));
  return {
    qty: Decimal.from(rec?.qty ?? "0").sub(m?.qty ?? "0"),
    value: Decimal.from(rec?.value ?? "0").sub(m?.value ?? "0"),
  };
}

/**
 * Plan how a bill's lines draw on purchase-order lines. Locks the purchase
 * orders so two bills cannot over-bill the same order concurrently.
 */
export async function planPoMatching(
  tx: Tx,
  ctx: Ctx,
  bill: { id: string; contactId: string | null },
  billLines: { id: string; lineNo: number; sourceLineId: string | null; itemId: string | null; quantity: string }[],
  opts: { allowOverBilling?: boolean } = {},
): Promise<Map<string, PoMatchPlan>> {
  const plan = new Map<string, PoMatchPlan>();
  const sourced = billLines.filter((l) => l.sourceLineId);
  if (!sourced.length) return plan;
  const poLines = await tx
    .select()
    .from(documentLines)
    .where(and(eq(documentLines.orgId, ctx.orgId), inArray(documentLines.id, sourced.map((l) => l.sourceLineId!))));
  const poIds = [...new Set(poLines.map((l) => l.documentId))];
  const pos = poIds.length
    ? await tx
        .select()
        .from(documents)
        .where(and(eq(documents.orgId, ctx.orgId), inArray(documents.id, poIds)))
        .orderBy(asc(documents.id))
        .for("update")
    : [];
  const poMap = new Map(pos.map((p) => [p.id, p]));
  const itemIds = [...new Set(poLines.map((l) => l.itemId).filter(Boolean))] as string[];
  const itemRows = itemIds.length ? await tx.select().from(items).where(and(eq(items.orgId, ctx.orgId), inArray(items.id, itemIds))) : [];
  const stockItems = new Set(itemRows.filter((i) => i.kind === "stock").map((i) => i.id));
  // Several bill lines may draw on one PO line; track what this bill has used.
  const usedQty = new Map<string, Decimal>();
  const usedValue = new Map<string, Decimal>();
  const baseMu = minorUnits(ctx.org.baseCurrency);

  for (const bl of sourced) {
    const pl = poLines.find((p) => p.id === bl.sourceLineId);
    if (!pl) continue; // Not a purchase-order line (an estimate line, say): nothing to match.
    const po = poMap.get(pl.documentId);
    if (!po || po.kind !== "purchase_order") continue;
    if (!["issued", "partially_received", "received"].includes(po.status)) {
      throw new ConflictError(`Purchase order ${po.number} is ${po.status}; bill against an open purchase order or remove the link.`, "po_not_open");
    }
    if (po.contactId !== bill.contactId) throw new ValidationError(`Line ${bl.lineNo} comes from purchase order ${po.number}, which is for a different vendor.`);
    if (bl.itemId !== pl.itemId) throw new ValidationError(`Line ${bl.lineNo} must bill the same item as the purchase-order line it comes from.`);
    const billedQty = Decimal.from(bl.quantity);
    if (!billedQty.isPositive()) throw new ValidationError(`Line ${bl.lineNo}: bill a positive quantity against the purchase order.`);
    const ordered = Decimal.from(pl.quantity);
    const priorUse = usedQty.get(pl.id) ?? Decimal.ZERO;
    const alreadyBilled = Decimal.from(pl.billedQuantity).add(priorUse);
    if (alreadyBilled.add(billedQty).gt(ordered) && !opts.allowOverBilling) {
      throw new ConflictError(
        `Line ${bl.lineNo} bills ${billedQty.normalize().toString()} but only ${ordered.sub(alreadyBilled).normalize().toString()} of purchase order ${po.number}'s ${ordered.normalize().toString()} remain unbilled. Confirm the over-billing to post it anyway.`,
        "over_billing",
        { line: bl.lineNo, remaining: ordered.sub(alreadyBilled).toString() },
      );
    }
    const isStock = !!pl.itemId && stockItems.has(pl.itemId);
    const un = await unbilledReceived(tx, ctx.orgId, pl.id);
    const availQty = un.qty.sub(priorUse);
    const availValue = un.value.sub(usedValue.get(pl.id) ?? Decimal.ZERO);
    const matchedQty = Decimal.max(Decimal.ZERO, Decimal.min(billedQty, availQty));
    let grniValue = Decimal.ZERO;
    if (isStock && matchedQty.isPositive()) {
      grniValue = matchedQty.eq(availQty) ? availValue : availValue.mulDiv(matchedQty, availQty, baseMu, "half_up");
    }
    usedQty.set(pl.id, priorUse.add(billedQty));
    usedValue.set(pl.id, (usedValue.get(pl.id) ?? Decimal.ZERO).add(grniValue));
    plan.set(bl.id, {
      poId: po.id,
      poLineId: pl.id,
      billLineId: bl.id,
      isStock,
      billedQty,
      matchedQty,
      receivedWithBill: billedQty.sub(matchedQty),
      grniValue,
    });
  }
  return plan;
}

/** Record the matches of an issued bill and move its purchase orders' quantities and status. */
export async function recordPoMatches(tx: Tx, ctx: Ctx, billId: string, plan: Map<string, PoMatchPlan>, variance: Map<string, Decimal>) {
  if (!plan.size) return;
  for (const p of plan.values()) {
    await tx.insert(poBillMatches).values({
      orgId: ctx.orgId,
      billId,
      billLineId: p.billLineId,
      poLineId: p.poLineId,
      billedQuantity: p.billedQty.toString(),
      matchedQuantity: p.matchedQty.toString(),
      receivedWithBill: p.receivedWithBill.toString(),
      grniValue: p.grniValue.toString(),
      varianceValue: (variance.get(p.billLineId) ?? Decimal.ZERO).toString(),
    });
    await tx
      .update(documentLines)
      .set({
        billedQuantity: sql`${documentLines.billedQuantity} + ${p.billedQty.toString()}`,
        receivedQuantity: sql`${documentLines.receivedQuantity} + ${p.receivedWithBill.toString()}`,
        billedOnLineId: p.billLineId,
      })
      .where(and(eq(documentLines.orgId, ctx.orgId), eq(documentLines.id, p.poLineId)));
  }
  for (const poId of new Set([...plan.values()].map((p) => p.poId))) await refreshPoStatus(tx, ctx, poId);
}

/** Undo a voided bill's matches: the purchase-order lines are open to bill again. */
export async function unwindPoMatches(tx: Tx, ctx: Ctx, billId: string) {
  const matches = await tx
    .select()
    .from(poBillMatches)
    .where(and(eq(poBillMatches.orgId, ctx.orgId), eq(poBillMatches.billId, billId), eq(poBillMatches.status, "active")));
  if (!matches.length) return;
  const poIds = new Set<string>();
  for (const m of matches) {
    await tx.update(poBillMatches).set({ status: "reversed" }).where(eq(poBillMatches.id, m.id));
    const [pl] = await tx
      .update(documentLines)
      .set({
        billedQuantity: sql`${documentLines.billedQuantity} - ${m.billedQuantity}`,
        receivedQuantity: sql`${documentLines.receivedQuantity} - ${m.receivedWithBill}`,
      })
      .where(and(eq(documentLines.orgId, ctx.orgId), eq(documentLines.id, m.poLineId)))
      .returning({ documentId: documentLines.documentId });
    if (pl) poIds.add(pl.documentId);
  }
  for (const id of poIds) await refreshPoStatus(tx, ctx, id);
}

/**
 * A purchase order's status from its lines: received when every line is
 * fully received, partially received when any is, closed when every line is
 * both received and billed. A cancelled or manually closed order stays so.
 */
export async function refreshPoStatus(tx: Tx, ctx: Ctx, poId: string) {
  const [po] = await tx.select().from(documents).where(and(eq(documents.orgId, ctx.orgId), eq(documents.id, poId)));
  if (!po || po.kind !== "purchase_order") return;
  if (["draft", "cancelled"].includes(po.status)) return;
  const [manual] = await tx
    .select({ id: poClosures.id })
    .from(poClosures)
    .where(and(eq(poClosures.orgId, ctx.orgId), eq(poClosures.purchaseOrderId, poId), sql`${poClosures.reopenedAt} is null`));
  const lines = await tx.select().from(documentLines).where(and(eq(documentLines.orgId, ctx.orgId), eq(documentLines.documentId, poId)));
  const all = (f: (l: (typeof lines)[number]) => boolean) => lines.length > 0 && lines.every(f);
  const received = (l: (typeof lines)[number]) => Decimal.from(l.receivedQuantity).gte(l.quantity);
  const billed = (l: (typeof lines)[number]) => Decimal.from(l.billedQuantity).gte(l.quantity);
  let status: DocumentStatus;
  if (all((l) => received(l) && billed(l))) status = "closed";
  else if (manual) status = "closed";
  else if (all(received)) status = "received";
  else if (lines.some((l) => Decimal.from(l.receivedQuantity).isPositive())) status = "partially_received";
  else status = "issued";
  if (status !== po.status) {
    await tx.update(documents).set({ status, updatedAt: new Date() }).where(eq(documents.id, poId));
  }
}
