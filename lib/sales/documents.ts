/**
 * Sales-side services over the commerce core: what a document page shows,
 * duplicating, emailing a document or statement with its PDF attached, and
 * the open credits a customer can apply.
 */
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { getDb, withTransaction, type DbOrTx } from "@/lib/db/client";
import { documents, payments, settlements } from "@/lib/db/schema/commerce";
import { contacts, taxJurisdictions } from "@/lib/db/schema/ledger";
import { audit } from "@/lib/audit";
import { requirePermission, type Ctx } from "@/lib/context";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { Decimal } from "@/lib/money/decimal";
import { todayIn } from "@/lib/dates";
import { getDocument, inputFromDocument, saveDraft, type Document } from "@/lib/commerce/documents";
import { itemBalance, openItemsForContact } from "@/lib/commerce/open-items";
import { KIND_LABELS } from "@/lib/commerce/states";
import { listEmails, queueEmail } from "@/lib/email/send";
import { uploadAttachment, listAttachments } from "@/lib/storage/attachments";
import { formatDate, formatMoney } from "@/lib/money/format";
import { paymentLinksFor, openPaymentLink } from "@/lib/integrations/payments/links";
import { renderDocumentPdf, renderStatementPdf } from "./pdf";
import { customerStatement } from "./statements";

export async function documentDetail(db: DbOrTx, orgId: string, id: string) {
  const { doc, lines, taxes } = await getDocument(db, orgId, id);
  const [contact] = doc.contactId ? await db.select().from(contacts).where(and(eq(contacts.orgId, orgId), eq(contacts.id, doc.contactId))) : [];
  const jurIds = [...new Set(taxes.map((t) => t.jurisdictionId))];
  const jurs = jurIds.length ? await db.select().from(taxJurisdictions).where(and(eq(taxJurisdictions.orgId, orgId), inArray(taxJurisdictions.id, jurIds))) : [];
  const taxSummary = new Map<string, { name: string; rate: string; taxable: Decimal; amount: Decimal; exempt: boolean }>();
  for (const t of taxes) {
    const key = `${t.jurisdictionId}|${t.rate}|${t.isExempt}`;
    const cur = taxSummary.get(key) ?? { name: jurs.find((j) => j.id === t.jurisdictionId)?.name ?? "Tax", rate: t.rate, taxable: Decimal.ZERO, amount: Decimal.ZERO, exempt: t.isExempt };
    cur.taxable = cur.taxable.add(t.taxableAmount);
    cur.amount = cur.amount.add(t.taxAmount);
    taxSummary.set(key, cur);
  }
  const apps = await db
    .select()
    .from(settlements)
    .where(and(eq(settlements.orgId, orgId), or(eq(settlements.debitItemId, id), eq(settlements.creditItemId, id))!))
    .orderBy(desc(settlements.settlementDate), desc(settlements.createdAt));
  const otherIds = apps.map((s) => (s.debitItemId === id ? s.creditItemId : s.debitItemId));
  const otherDocs = otherIds.length ? await db.select().from(documents).where(and(eq(documents.orgId, orgId), inArray(documents.id, otherIds))) : [];
  const otherPays = otherIds.length ? await db.select().from(payments).where(and(eq(payments.orgId, orgId), inArray(payments.id, otherIds))) : [];
  const applications = apps.map((s) => {
    const otherId = s.debitItemId === id ? s.creditItemId : s.debitItemId;
    const d = otherDocs.find((x) => x.id === otherId);
    const p = otherPays.find((x) => x.id === otherId);
    return {
      settlement: s,
      other: d
        ? { type: "document" as const, id: d.id, kind: d.kind as string, label: `${KIND_LABELS[d.kind]} ${d.number ?? ""}`.trim() }
        : p
          ? { type: "payment" as const, id: p.id, kind: p.kind as string, label: `${p.kind.replace(/_/g, " ")} ${p.number ?? ""}`.trim() }
          : { type: "document" as const, id: otherId, kind: "unknown", label: "Unknown item" },
    };
  });
  const posted = !!doc.journalEntryId && ["invoice", "credit_note", "write_off"].includes(doc.kind);
  const bal = posted ? await itemBalance(db, orgId, id) : null;
  const open = bal ? (doc.kind === "invoice" ? bal.txn : bal.txn.neg()) : null;
  return {
    doc,
    lines,
    taxes,
    taxSummary: [...taxSummary.values()],
    contact: contact ?? null,
    applications,
    open: open?.toString() ?? null,
    emails: await listEmails(db, orgId, { entityType: "document", entityId: id }),
    files: await listAttachments(db, orgId, "document", id),
    links: await paymentLinksFor(db, orgId, id),
    openLink: await openPaymentLink(db, orgId, id),
  };
}

/** Open credits for a customer that can pay an invoice: unapplied payments, deposits, credit notes. */
export async function openCreditsFor(db: DbOrTx, ctx: Ctx, contactId: string, currency: string) {
  const items = await openItemsForContact(db, ctx.orgId, "receivables", contactId);
  return items.filter((i) => i.nature === "credit" && i.currency === currency && Decimal.from(i.openTxn).isPositive());
}

/** A new draft with the same customer and lines, dated today. */
export async function duplicateDocument(ctx: Ctx, id: string): Promise<Document> {
  const { doc, lines } = await getDocument(getDb(), ctx.orgId, id);
  if (doc.kind === "write_off") throw new ValidationError("Write-offs are made from an invoice, not copied.");
  const input = inputFromDocument(doc, lines);
  return saveDraft(ctx, {
    ...input,
    issueDate: todayIn(ctx.org.timezone),
    postingDate: null,
    dueDate: null,
    expiryDate: null,
    sourceDocumentId: null,
    recurringTemplateId: null,
    lines: input.lines.map((l) => ({ ...l, sourceLineId: null, returnOfLineId: null })),
  });
}

function defaultMessage(ctx: Ctx, doc: Document, contactName: string, open: string | null): { subject: string; body: string } {
  const label = KIND_LABELS[doc.kind];
  const amount = formatMoney(open ?? doc.total, doc.currency, { accounting: false });
  const lines = [`Hello ${contactName},`, ""];
  if (doc.kind === "invoice") {
    lines.push(`Attached is invoice ${doc.number} for ${amount}${doc.dueDate ? `, due ${formatDate(doc.dueDate)}` : ""}.`);
  } else if (doc.kind === "estimate") {
    lines.push(`Attached is estimate ${doc.number} for ${formatMoney(doc.total, doc.currency, { accounting: false })}${doc.expiryDate ? `, valid until ${formatDate(doc.expiryDate)}` : ""}.`);
  } else {
    lines.push(`Attached is ${label.toLowerCase()} ${doc.number} for ${formatMoney(doc.total, doc.currency, { accounting: false })}.`);
  }
  lines.push("", "Thank you,", ctx.org.name);
  return { subject: `${label} ${doc.number} from ${ctx.org.name}`, body: lines.join("\n") };
}

export async function emailDefaults(ctx: Ctx, id: string) {
  const db = getDb();
  const { doc } = await getDocument(db, ctx.orgId, id);
  const [contact] = doc.contactId ? await db.select().from(contacts).where(and(eq(contacts.orgId, ctx.orgId), eq(contacts.id, doc.contactId))) : [];
  const open = doc.kind === "invoice" && doc.journalEntryId ? (await itemBalance(db, ctx.orgId, id)).txn.toString() : null;
  const m = defaultMessage(ctx, doc, contact?.displayName ?? "", open);
  const link = doc.kind === "invoice" ? await openPaymentLink(db, ctx.orgId, id) : null;
  return { to: contact?.email ?? "", subject: m.subject, body: link ? `${m.body}\n\nPay online: ${link.url}` : m.body };
}

/**
 * Email a document to the customer with its PDF attached. The message is
 * queued and delivered by the configured provider (or kept in the outbox,
 * which delivers nothing — the page says so).
 */
export async function emailDocument(ctx: Ctx, id: string, input: { to: string; cc?: string | null; subject?: string | null; body?: string | null }) {
  requirePermission(ctx, "sales.manage");
  const db = getDb();
  const { doc } = await getDocument(db, ctx.orgId, id);
  if (doc.side !== "sales") throw new NotFoundError("The sales document");
  if (doc.status === "draft") throw new ValidationError("Issue the document before sending it.");
  if (doc.status === "void") throw new ValidationError("A void document is not sent.");
  const defaults = await emailDefaults(ctx, id);
  const pdf = await renderDocumentPdf(db, ctx.orgId, id);
  const att = await uploadAttachment(ctx, { entityType: "document", entityId: id, fileName: pdf.fileName, contentType: "application/pdf", bytes: Buffer.from(pdf.bytes), origin: "generated" });
  return withTransaction(async (tx) => {
    const msg = await queueEmail(tx, ctx, {
      to: input.to,
      cc: input.cc ?? null,
      replyTo: ctx.org.profile?.email ?? null,
      subject: input.subject?.trim() || defaults.subject,
      text: input.body?.trim() || defaults.body,
      attachmentIds: [att.id],
      entityType: "document",
      entityId: id,
    });
    await tx.update(documents).set({ sentAt: new Date(), updatedAt: new Date() }).where(and(eq(documents.orgId, ctx.orgId), eq(documents.id, id)));
    await audit(tx, ctx, { action: "document.sent", entityType: "document", entityId: id, metadata: { to: input.to, messageId: msg.id, provider: msg.provider } });
    return msg;
  });
}

export async function emailStatement(ctx: Ctx, contactId: string, input: { from: string; to: string; email: string; cc?: string | null; body?: string | null }) {
  requirePermission(ctx, "sales.manage");
  const db = getDb();
  const s = await customerStatement(db, ctx, contactId, input.from, input.to);
  const pdf = await renderStatementPdf(db, ctx.orgId, s);
  const att = await uploadAttachment(ctx, { entityType: "contact", entityId: contactId, fileName: pdf.fileName, contentType: "application/pdf", bytes: Buffer.from(pdf.bytes), origin: "generated" });
  const body =
    input.body?.trim() ||
    [
      `Hello ${s.contact.displayName},`,
      "",
      `Attached is your statement for ${formatDate(input.from)} to ${formatDate(input.to)}. The balance on ${formatDate(input.to)} is ${formatMoney(s.closing, s.currency, { accounting: false })}.`,
      "",
      "Thank you,",
      ctx.org.name,
    ].join("\n");
  return withTransaction((tx) =>
    queueEmail(tx, ctx, {
      to: input.email,
      cc: input.cc ?? null,
      replyTo: ctx.org.profile?.email ?? null,
      subject: `Statement from ${ctx.org.name}`,
      text: body,
      attachmentIds: [att.id],
      entityType: "contact",
      entityId: contactId,
    }),
  );
}

/** Recent sales documents and payments for a contact (the contact page). */
export async function contactActivity(db: DbOrTx, orgId: string, contactId: string) {
  const docs = await db.select().from(documents).where(and(eq(documents.orgId, orgId), eq(documents.contactId, contactId))).orderBy(desc(documents.issueDate), desc(documents.createdAt)).limit(25);
  const pays = await db.select().from(payments).where(and(eq(payments.orgId, orgId), eq(payments.contactId, contactId))).orderBy(desc(payments.paymentDate), desc(payments.createdAt)).limit(25);
  return { docs, pays };
}
