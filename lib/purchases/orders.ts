/**
 * Purchase-order helpers: turning an order (what is left of it) into a draft
 * bill, and copying documents.
 */
import { and, asc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { documentLines, documents } from "@/lib/db/schema/commerce";
import { requirePermission, type Ctx } from "@/lib/context";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { Decimal } from "@/lib/money/decimal";
import { todayIn } from "@/lib/dates";
import { getDocument, inputFromDocument, saveDraft, type Document } from "@/lib/commerce/documents";

/**
 * A draft bill for what remains unbilled on a purchase order, each line
 * linked to its order line so issuing it matches against receipts.
 */
export async function billFromPurchaseOrder(ctx: Ctx, poId: string): Promise<Document> {
  requirePermission(ctx, "purchases.manage");
  const db = getDb();
  const [po] = await db.select().from(documents).where(and(eq(documents.orgId, ctx.orgId), eq(documents.id, poId)));
  if (!po || po.kind !== "purchase_order") throw new NotFoundError("The purchase order");
  if (!["issued", "partially_received", "received"].includes(po.status)) throw new ConflictError(`Purchase order ${po.number ?? ""} is ${po.status}; it cannot be billed.`, "po_not_open");
  const lines = await db.select().from(documentLines).where(and(eq(documentLines.orgId, ctx.orgId), eq(documentLines.documentId, poId))).orderBy(asc(documentLines.lineNo));
  const input = inputFromDocument(po, lines);
  const remaining = input.lines.flatMap((l, i) => {
    const pl = lines[i]!;
    const left = Decimal.from(pl.quantity).sub(pl.billedQuantity);
    return left.isPositive() ? [{ ...l, quantity: left.normalize().toString(), sourceLineId: pl.id }] : [];
  });
  if (!remaining.length) throw new ConflictError("Everything on this order has been billed.", "fully_billed");
  return saveDraft(ctx, {
    ...input,
    kind: "bill",
    issueDate: todayIn(ctx.org.timezone),
    postingDate: null,
    dueDate: null,
    expiryDate: null,
    reference: null,
    // A percentage discount carries over; a fixed-amount discount belongs to the whole order and does not.
    discountType: input.discountType === "percent" ? "percent" : null,
    discountValue: input.discountType === "percent" ? input.discountValue : null,
    sourceDocumentId: po.id,
    lines: remaining,
  });
}

/** A new draft copying a document's lines (dated today, unlinked from any order). */
export async function duplicateDocument(ctx: Ctx, id: string): Promise<Document> {
  const { doc, lines } = await getDocument(getDb(), ctx.orgId, id);
  const input = inputFromDocument(doc, lines);
  return saveDraft(ctx, {
    ...input,
    issueDate: todayIn(ctx.org.timezone),
    postingDate: null,
    dueDate: null,
    reference: null,
    sourceDocumentId: null,
    recurringTemplateId: null,
    isOpeningBalance: false,
    lines: input.lines.map((l) => ({ ...l, sourceLineId: null, returnOfLineId: null })),
  });
}

/** A draft vendor credit returning lines of a bill (stock comes back out at the credited value). */
export async function vendorCreditFromBill(ctx: Ctx, billId: string): Promise<Document> {
  requirePermission(ctx, "purchases.manage");
  const { doc, lines } = await getDocument(getDb(), ctx.orgId, billId);
  if (doc.kind !== "bill") throw new NotFoundError("The bill");
  if (doc.status === "draft" || doc.status === "void") throw new ConflictError(`This bill is ${doc.status}.`, "bill_not_open");
  const input = inputFromDocument(doc, lines);
  return saveDraft(ctx, {
    ...input,
    kind: "vendor_credit",
    issueDate: todayIn(ctx.org.timezone),
    postingDate: null,
    dueDate: null,
    reference: null,
    sourceDocumentId: doc.id,
    lines: input.lines.map((l, i) => ({ ...l, sourceLineId: null, returnOfLineId: lines[i]!.id })),
  });
}
