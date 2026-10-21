"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db/client";
import {
  convertEstimate,
  deleteDraft,
  getDocument,
  issueDocument,
  saveDraft,
  setEstimateStatus,
  voidDocument,
  writeOffInvoice,
} from "@/lib/commerce/documents";
import { applyCredit, recordPayment, unapply, voidPayment, type PaymentInput } from "@/lib/commerce/payments";
import type { DocumentKind, PaymentKind } from "@/lib/db/schema/commerce";
import { duplicateDocument, emailDocument, emailStatement } from "@/lib/sales/documents";
import {
  createRecurringTemplate,
  deleteRecurringTemplate,
  runTemplateNow,
  setRecurringStatus,
  updateRecurringContent,
  updateRecurringSchedule,
  type Frequency,
} from "@/lib/sales/recurring";
import { createPaymentLink } from "@/lib/integrations/payments/links";
import { simulateSandboxPayout, simulateSandboxRefund } from "@/lib/integrations/payments/sandbox-sim";
import { connectSandbox, connectStripe, disconnectPaymentConnection, updatePaymentConnectionAccounts } from "@/lib/integrations/payments/connections";
import { inputFromDocument } from "@/lib/commerce/documents";
import { parseDocumentForm } from "@/lib/web/document-form";
import { documentPath } from "@/lib/web/routes";
import { bool, runAction, str, type ActionResult } from "@/lib/web/actions";
import { orgCtx } from "@/lib/web/session";
import { ValidationError } from "@/lib/errors";
import { todayIn } from "@/lib/dates";

type R<T = unknown> = Promise<ActionResult<T>>;

/** Save a document from the editor; intent "issue" also issues it. */
export async function saveDocumentAction(slug: string, kind: DocumentKind, id: string | null, _: unknown, fd: FormData): R<{ href: string }> {
  return runAction(async () => {
    const ctx = await orgCtx(slug);
    const input = parseDocumentForm(fd, kind);
    const doc = await saveDraft(ctx, input, id);
    if (str(fd, "intent") === "issue") await issueDocument(ctx, doc.id);
    return { href: documentPath(`/o/${slug}`, kind, doc.id) };
  });
}

export async function issueDocumentAction(slug: string, id: string): R {
  return runAction(async () => {
    const ctx = await orgCtx(slug);
    await issueDocument(ctx, id);
    revalidatePath(`/o/${slug}/sales`, "layout");
  }, "Issued.");
}

export async function deleteDocumentAction(slug: string, id: string, listPath: string): R<{ href: string }> {
  return runAction(async () => {
    await deleteDraft(await orgCtx(slug), id);
    return { href: `/o/${slug}${listPath}` };
  });
}

export async function voidDocumentAction(slug: string, id: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await voidDocument(await orgCtx(slug), id, { date: str(fd, "date"), reason: str(fd, "reason") ?? "" });
  }, "Voided. Everything it posted was reversed on the void date.");
}

export async function writeOffAction(slug: string, id: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await writeOffInvoice(await orgCtx(slug), id, { date: str(fd, "date") ?? "", reason: str(fd, "reason") ?? "", amount: str(fd, "amount") });
  }, "The balance was written off as bad debt.");
}

export async function duplicateDocumentAction(slug: string, id: string): R<{ href: string }> {
  return runAction(async () => {
    const doc = await duplicateDocument(await orgCtx(slug), id);
    return { href: `${documentPath(`/o/${slug}`, doc.kind, doc.id)}/edit` };
  });
}

export async function estimateStatusAction(slug: string, id: string, status: "sent" | "accepted" | "declined" | "expired"): R {
  return runAction(async () => {
    await setEstimateStatus(await orgCtx(slug), id, status);
  }, `Marked ${status}.`);
}

export async function convertEstimateAction(slug: string, id: string): R<{ href: string }> {
  return runAction(async () => {
    const inv = await convertEstimate(await orgCtx(slug), id);
    return { href: `/o/${slug}/sales/invoices/${inv.id}/edit` };
  });
}

export async function emailDocumentAction(slug: string, id: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    const to = str(fd, "to");
    if (!to) throw new ValidationError("Enter the address to send to.", { to: "Required." });
    const msg = await emailDocument(await orgCtx(slug), id, { to, cc: str(fd, "cc"), subject: str(fd, "subject"), body: str(fd, "body") });
    return msg.provider === "outbox" ? "outbox" : "sent";
  }, "Queued. Its delivery is shown below.");
}

export async function applyCreditAction(slug: string, debit: { type: "document" | "payment"; id: string }, _: unknown, fd: FormData): R {
  return runAction(async () => {
    const credit = str(fd, "credit");
    if (!credit) throw new ValidationError("Choose the credit to apply.", { credit: "Required." });
    const [type, id] = credit.split(":") as ["document" | "payment", string];
    await applyCredit(await orgCtx(slug), { debit, credit: { type, id }, amount: str(fd, "amount") ?? "", date: str(fd, "date") ?? "" });
  }, "Applied.");
}

/** Apply this credit (a credit note or unapplied payment) to one of the customer's open invoices. */
export async function applyToInvoiceAction(slug: string, credit: { type: "document" | "payment"; id: string }, _: unknown, fd: FormData): R {
  return runAction(async () => {
    const invoiceId = str(fd, "invoiceId");
    if (!invoiceId) throw new ValidationError("Choose the invoice.", { invoiceId: "Required." });
    await applyCredit(await orgCtx(slug), { debit: { type: "document", id: invoiceId }, credit, amount: str(fd, "amount") ?? "", date: str(fd, "date") ?? "" });
  }, "Applied.");
}

export async function unapplyAction(slug: string, settlementId: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await unapply(await orgCtx(slug), settlementId, { date: str(fd, "date") ?? "", reason: str(fd, "reason") ?? "" });
  }, "Removed. Both items are open again.");
}

export async function createPaymentLinkAction(slug: string, invoiceId: string): R {
  return runAction(async () => {
    await createPaymentLink(await orgCtx(slug), invoiceId);
  }, "Payment link ready.");
}

/** The receive-payment form. */
export async function receivePaymentAction(slug: string, _: unknown, fd: FormData): R<{ href: string }> {
  return runAction(async () => {
    const ctx = await orgCtx(slug);
    const allocations: PaymentInput["allocations"] = [];
    const count = Number(fd.get("allocationCount") ?? 0);
    for (let i = 0; i < Math.min(count, 500); i++) {
      const id = str(fd, `alloc.${i}.id`);
      const amount = str(fd, `alloc.${i}.amount`);
      if (id && amount) allocations.push({ itemType: (str(fd, `alloc.${i}.type`) ?? "document") as "document" | "payment", itemId: id, amount });
    }
    const kind = (str(fd, "kind") ?? "customer_payment") as PaymentKind;
    if (!["customer_payment", "customer_deposit", "customer_refund"].includes(kind)) throw new ValidationError("Choose what kind of payment this is.");
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
        feeAmount: str(fd, "feeAmount"),
        feeAccountId: str(fd, "feeAccountId"),
        method: (str(fd, "method") ?? "other") as PaymentInput["method"],
        reference: str(fd, "reference"),
        memo: str(fd, "memo"),
        allocations: kind === "customer_deposit" ? [] : allocations,
      },
      { idempotencyKey: str(fd, "idempotencyKey") },
    );
    return { href: `/o/${slug}/sales/payments/${p.id}` };
  });
}

export async function voidPaymentAction(slug: string, id: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await voidPayment(await orgCtx(slug), id, { date: str(fd, "date") ?? "", reason: str(fd, "reason") ?? "" });
  }, "Voided. Its applications were removed and its entry reversed.");
}

/** Refund an unapplied credit (overpayment, credit note) to the customer. */
export async function refundCreditAction(slug: string, credit: { type: "document" | "payment"; id: string }, contactId: string, currency: string, _: unknown, fd: FormData): R<{ href: string }> {
  return runAction(async () => {
    const ctx = await orgCtx(slug);
    const amount = str(fd, "amount") ?? "";
    const p = await recordPayment(ctx, {
      kind: "customer_refund",
      contactId,
      paymentDate: str(fd, "date") ?? "",
      accountId: str(fd, "accountId") ?? "",
      currency,
      amount,
      method: (str(fd, "method") ?? "other") as PaymentInput["method"],
      reference: str(fd, "reference"),
      memo: "Refund",
      allocations: [{ itemType: credit.type, itemId: credit.id, amount }],
    });
    return { href: `/o/${slug}/sales/payments/${p.id}` };
  });
}

export async function simulateRefundAction(slug: string, paymentId: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    const out = await simulateSandboxRefund(await orgCtx(slug), paymentId, str(fd, "amount") ?? "");
    return out.detail;
  }, "Sandbox refund received and recorded.");
}

// ── Recurring ───────────────────────────────────────────────────────────────

export async function createRecurringAction(slug: string, _: unknown, fd: FormData): R<{ href: string }> {
  return runAction(async () => {
    const t = await createRecurringTemplate(await orgCtx(slug), parseDocumentForm(fd, "invoice"));
    return { href: `/o/${slug}/sales/recurring/${t.id}?new=1` };
  });
}

export async function makeRecurringAction(slug: string, invoiceId: string): R<{ href: string }> {
  return runAction(async () => {
    const ctx = await orgCtx(slug);
    const { doc, lines } = await getDocument(getDb(), ctx.orgId, invoiceId);
    const t = await createRecurringTemplate(ctx, { ...inputFromDocument(doc, lines), kind: "invoice" }, undefined);
    return { href: `/o/${slug}/sales/recurring/${t.id}?new=1` };
  });
}

export async function updateRecurringContentAction(slug: string, id: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await updateRecurringContent(await orgCtx(slug), id, parseDocumentForm(fd, "invoice"));
  }, "Invoice template saved.");
}

export async function updateRecurringScheduleAction(slug: string, id: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    const ctx = await orgCtx(slug);
    await updateRecurringSchedule(ctx, id, {
      name: str(fd, "name") ?? "",
      frequency: (str(fd, "frequency") ?? "monthly") as Frequency,
      interval: Number(str(fd, "interval") ?? "1"),
      startDate: str(fd, "startDate") ?? "",
      endDate: str(fd, "endDate"),
      maxOccurrences: str(fd, "maxOccurrences") ? Number(str(fd, "maxOccurrences")) : null,
      autoIssue: bool(fd, "autoIssue"),
      autoSend: bool(fd, "autoSend"),
    });
    if (bool(fd, "activate")) await setRecurringStatus(ctx, id, "active");
  }, "Schedule saved.");
}

export async function recurringStatusAction(slug: string, id: string, status: "active" | "paused"): R {
  return runAction(async () => {
    await setRecurringStatus(await orgCtx(slug), id, status);
  }, status === "active" ? "Turned on." : "Paused.");
}

export async function runRecurringNowAction(slug: string, id: string): R {
  return runAction(async () => {
    const r = await runTemplateNow(await orgCtx(slug), id);
    if (r.errors.length) throw new ValidationError(r.errors.join(" "));
    return r;
  }, "Due invoices were made.");
}

export async function deleteRecurringAction(slug: string, id: string): R<{ href: string }> {
  return runAction(async () => {
    await deleteRecurringTemplate(await orgCtx(slug), id);
    return { href: `/o/${slug}/sales/recurring` };
  });
}

// ── Statements ──────────────────────────────────────────────────────────────

export async function emailStatementAction(slug: string, contactId: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    const ctx = await orgCtx(slug);
    const email = str(fd, "email");
    if (!email) throw new ValidationError("Enter the address to send to.", { email: "Required." });
    await emailStatement(ctx, contactId, { from: str(fd, "from") ?? "", to: str(fd, "to") ?? todayIn(ctx.org.timezone), email, cc: str(fd, "cc"), body: str(fd, "body") });
  }, "Statement queued. Its delivery is under Settings → Email.");
}

// ── Payment provider connection ─────────────────────────────────────────────

export async function connectStripeAction(slug: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await connectStripe(await orgCtx(slug), {
      apiKey: str(fd, "apiKey") ?? "",
      webhookSecret: str(fd, "webhookSecret") ?? "",
      clearingAccountId: str(fd, "clearingAccountId"),
      bankAccountId: str(fd, "bankAccountId"),
      feeAccountId: str(fd, "feeAccountId"),
    });
  }, "Stripe connected. Add the webhook endpoint shown below in your Stripe dashboard.");
}

export async function connectSandboxAction(slug: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await connectSandbox(await orgCtx(slug), {
      clearingAccountId: str(fd, "clearingAccountId"),
      bankAccountId: str(fd, "bankAccountId"),
      feeAccountId: str(fd, "feeAccountId"),
      feePercent: str(fd, "feePercent"),
    });
  }, "Sandbox connected. No real money can move through it.");
}

export async function updateConnectionAction(slug: string, id: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await updatePaymentConnectionAccounts(await orgCtx(slug), id, {
      clearingAccountId: str(fd, "clearingAccountId"),
      bankAccountId: str(fd, "bankAccountId"),
      feeAccountId: str(fd, "feeAccountId"),
    });
  }, "Saved.");
}

export async function disconnectAction(slug: string, id: string): R {
  return runAction(async () => {
    await disconnectPaymentConnection(await orgCtx(slug), id);
  }, "Disconnected. Recorded payments stay in the books.");
}

export async function simulatePayoutAction(slug: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    const out = await simulateSandboxPayout(await orgCtx(slug), str(fd, "amount") ?? "");
    return out.detail;
  }, "Sandbox payout received and recorded.");
}
