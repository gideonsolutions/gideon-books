"use server";

import { revalidatePath } from "next/cache";
import { deleteDraft, getDocument, inputFromDocument, issueDocument, saveDraft, voidDocument, type DocumentInput } from "@/lib/commerce/documents";
import { applyCredit, recordPayment, unapply, voidPayment, type AllocationInput } from "@/lib/commerce/payments";
import type { DocumentKind, PaymentKind } from "@/lib/db/schema/commerce";
import { billFromPurchaseOrder, duplicateDocument, vendorCreditFromBill } from "@/lib/purchases/orders";
import { closePurchaseOrder, receivePurchaseOrder, reopenPurchaseOrder, reverseReceipt } from "@/lib/purchases/receiving";
import { getRecurringBill, saveRecurringBill, setRecurringStatus } from "@/lib/purchases/recurring";
import { addToInbox, matchReceipt, unmatchReceipt } from "@/lib/purchases/receipts";
import { enqueue } from "@/lib/jobs/queue";
import { getDb } from "@/lib/db/client";
import { parseDocumentForm } from "@/lib/web/document-form";
import { bool, runAction, str, type ActionResult } from "@/lib/web/actions";
import { orgCtx } from "@/lib/web/session";
import { ValidationError } from "@/lib/errors";
import { PURCHASE_KINDS } from "@/components/purchases/kinds";

type R<T = unknown> = Promise<ActionResult<T>>;

/** Save a purchase document from the editor; intent "issue" also posts it. */
export async function saveDocumentAction(slug: string, kind: DocumentKind, id: string | null, receiptAttachmentId: string | null, _: unknown, fd: FormData): R<{ href: string }> {
  return runAction(async () => {
    const ctx = await orgCtx(slug);
    const input = parseDocumentForm(fd, kind);
    const doc = await saveDraft(ctx, input, id);
    // A document created from an inbox receipt takes the receipt with it.
    if (receiptAttachmentId && !id) await matchReceipt(ctx, receiptAttachmentId, doc.id);
    if (str(fd, "intent") === "issue") await issueDocument(ctx, doc.id, { allowOverBilling: bool(fd, "allowOverBilling") });
    return { href: `/o/${slug}${PURCHASE_KINDS[kind as keyof typeof PURCHASE_KINDS].path}/${doc.id}` };
  });
}

export async function issueAction(slug: string, kind: DocumentKind, id: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await issueDocument(await orgCtx(slug), id, { allowOverBilling: bool(fd, "allowOverBilling") });
    revalidatePath(`/o/${slug}${PURCHASE_KINDS[kind as keyof typeof PURCHASE_KINDS].path}/${id}`);
  }, kind === "purchase_order" ? "Purchase order issued." : "Posted.");
}

export async function voidAction(slug: string, id: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await voidDocument(await orgCtx(slug), id, { date: str(fd, "date"), reason: str(fd, "reason") ?? "" });
  }, "Voided. The reversing entries are dated the void date.");
}

export async function deleteDraftAction(slug: string, kind: DocumentKind, id: string): R<{ href: string }> {
  return runAction(async () => {
    await deleteDraft(await orgCtx(slug), id);
    return { href: `/o/${slug}${PURCHASE_KINDS[kind as keyof typeof PURCHASE_KINDS].path}` };
  });
}

export async function duplicateAction(slug: string, kind: DocumentKind, id: string): R<{ href: string }> {
  return runAction(async () => {
    const copy = await duplicateDocument(await orgCtx(slug), id);
    return { href: `/o/${slug}${PURCHASE_KINDS[kind as keyof typeof PURCHASE_KINDS].path}/${copy.id}` };
  });
}

export async function creditFromBillAction(slug: string, billId: string): R<{ href: string }> {
  return runAction(async () => {
    const vc = await vendorCreditFromBill(await orgCtx(slug), billId);
    return { href: `/o/${slug}/purchases/credits/${vc.id}` };
  });
}

export async function billFromOrderAction(slug: string, poId: string): R<{ href: string }> {
  return runAction(async () => {
    const b = await billFromPurchaseOrder(await orgCtx(slug), poId);
    return { href: `/o/${slug}/purchases/bills/${b.id}` };
  });
}

export async function receiveAction(slug: string, poId: string, _: unknown, fd: FormData): R<{ href: string }> {
  return runAction(async () => {
    const lines: { poLineId: string; quantity: string }[] = [];
    for (const [k, v] of fd.entries()) {
      const m = /^receive\.([0-9a-f-]{36})$/.exec(k);
      if (m && typeof v === "string" && v.trim()) lines.push({ poLineId: m[1]!, quantity: v.trim() });
    }
    await receivePurchaseOrder(await orgCtx(slug), poId, { date: str(fd, "date") ?? "", locationId: str(fd, "locationId"), memo: str(fd, "memo"), lines });
    return { href: `/o/${slug}/purchases/orders/${poId}` };
  });
}

export async function reverseReceiptAction(slug: string, receiptId: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await reverseReceipt(await orgCtx(slug), receiptId, { date: str(fd, "date") ?? "", reason: str(fd, "reason") ?? "" });
  }, "Receipt reversed.");
}

export async function closeOrderAction(slug: string, poId: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await closePurchaseOrder(await orgCtx(slug), poId, str(fd, "reason") ?? "");
  }, "Purchase order closed.");
}

export async function reopenOrderAction(slug: string, poId: string): R {
  return runAction(async () => {
    await reopenPurchaseOrder(await orgCtx(slug), poId);
  }, "Purchase order reopened.");
}

function allocations(fd: FormData): AllocationInput[] {
  const out: AllocationInput[] = [];
  for (const [k, v] of fd.entries()) {
    const m = /^apply\.(document|payment)\.([0-9a-f-]{36})$/.exec(k);
    if (m && typeof v === "string" && v.trim()) out.push({ itemType: m[1] as "document" | "payment", itemId: m[2]!, amount: v.trim() });
  }
  return out;
}

export async function recordPaymentAction(slug: string, _: unknown, fd: FormData): R<{ href: string }> {
  return runAction(async () => {
    const ctx = await orgCtx(slug);
    const kind = (str(fd, "kind") ?? "vendor_payment") as PaymentKind;
    if (!["vendor_payment", "vendor_prepayment", "vendor_refund"].includes(kind)) throw new ValidationError("Choose what kind of payment this is.");
    const p = await recordPayment(
      ctx,
      {
        kind,
        contactId: str(fd, "contactId") ?? "",
        paymentDate: str(fd, "paymentDate") ?? "",
        accountId: str(fd, "accountId") ?? "",
        currency: str(fd, "currency"),
        amount: str(fd, "amount") ?? "",
        fxRate: str(fd, "fxRate"),
        accountAmount: str(fd, "accountAmount"),
        method: (str(fd, "method") ?? "other") as never,
        reference: str(fd, "reference"),
        memo: str(fd, "memo"),
        allocations: kind === "vendor_prepayment" ? [] : allocations(fd),
      },
      { idempotencyKey: str(fd, "idempotencyKey") },
    );
    return { href: `/o/${slug}/purchases/payments/${p.id}` };
  });
}

/**
 * Apply open credits (vendor payments, prepayments, vendor credits) to a
 * bill, or a credit to open bills — `target` is the item named in the page.
 */
export async function applyCreditsAction(slug: string, target: { type: "document" | "payment"; id: string; nature: "debit" | "credit" }, _: unknown, fd: FormData): R {
  return runAction(async () => {
    const ctx = await orgCtx(slug);
    const date = str(fd, "date") ?? "";
    const list = allocations(fd);
    if (!list.length) throw new ValidationError("Enter an amount to apply.");
    for (const a of list) {
      const other = { type: a.itemType, id: a.itemId };
      const self = { type: target.type, id: target.id };
      await applyCredit(ctx, { debit: target.nature === "debit" ? self : other, credit: target.nature === "credit" ? self : other, amount: a.amount, date });
    }
  }, "Applied.");
}

export async function unapplyAction(slug: string, settlementId: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await unapply(await orgCtx(slug), settlementId, { date: str(fd, "date") ?? "", reason: str(fd, "reason") ?? "" });
  }, "Application removed.");
}

export async function voidPaymentAction(slug: string, id: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await voidPayment(await orgCtx(slug), id, { date: str(fd, "date") ?? "", reason: str(fd, "reason") ?? "" });
  }, "Payment voided.");
}

export async function saveRecurringAction(slug: string, id: string | null, _: unknown, fd: FormData): R<{ href: string }> {
  return runAction(async () => {
    const ctx = await orgCtx(slug);
    const sourceBillId = str(fd, "sourceBillId");
    let bill: DocumentInput;
    if (sourceBillId) {
      const { doc, lines } = await getDocument(getDb(), ctx.orgId, sourceBillId);
      if (doc.kind !== "bill") throw new ValidationError("Choose a bill to copy.", { sourceBillId: "Not a bill." });
      const input = inputFromDocument(doc, lines);
      bill = { ...input, postingDate: null, dueDate: null, reference: null, sourceDocumentId: null, recurringTemplateId: null, lines: input.lines.map((l) => ({ ...l, sourceLineId: null, returnOfLineId: null })) };
    } else if (id) {
      bill = (await getRecurringBill(getDb(), ctx.orgId, id)).template.template as DocumentInput;
    } else {
      throw new ValidationError("Choose the bill each occurrence copies.", { sourceBillId: "Required." });
    }
    const t = await saveRecurringBill(
      ctx,
      {
        name: str(fd, "name") ?? "",
        frequency: (str(fd, "frequency") ?? "monthly") as never,
        interval: Number(str(fd, "interval") ?? "1"),
        startDate: str(fd, "startDate") ?? "",
        endDate: str(fd, "endDate"),
        maxOccurrences: str(fd, "maxOccurrences") ? Number(str(fd, "maxOccurrences")) : null,
        autoIssue: bool(fd, "autoIssue"),
        bill,
      },
      id,
    );
    return { href: `/o/${slug}/purchases/recurring/${t.id}` };
  });
}

export async function recurringStatusAction(slug: string, id: string, status: "active" | "paused" | "ended"): R {
  return runAction(async () => {
    await setRecurringStatus(await orgCtx(slug), id, status);
  }, status === "active" ? "Resumed." : status === "paused" ? "Paused." : "Ended.");
}

export async function runRecurringNowAction(slug: string, id: string): R {
  return runAction(async () => {
    const ctx = await orgCtx(slug);
    await enqueue(getDb(), "purchases.recurring", { templateId: id }, { orgId: ctx.orgId, createdBy: ctx.actor.userId });
  }, "Queued. Due bills will appear in a moment (see Background jobs).");
}

export async function uploadReceiptAction(slug: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    const ctx = await orgCtx(slug);
    const files = fd.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
    if (!files.length) throw new ValidationError("Choose one or more receipts.", { files: "Required." });
    for (const f of files) await addToInbox(ctx, { fileName: f.name, contentType: f.type, bytes: Buffer.from(await f.arrayBuffer()) });
  }, "Added to the inbox.");
}

export async function matchReceiptAction(slug: string, attachmentId: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    const documentId = str(fd, "documentId");
    if (!documentId) throw new ValidationError("Choose the bill or expense.", { documentId: "Required." });
    await matchReceipt(await orgCtx(slug), attachmentId, documentId);
  }, "Matched.");
}

export async function unmatchReceiptAction(slug: string, matchId: string): R {
  return runAction(async () => {
    await unmatchReceipt(await orgCtx(slug), matchId);
  }, "Unmatched; the receipt is back in the inbox.");
}
