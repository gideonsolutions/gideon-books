/**
 * PDFs for customers: invoices, estimates, credit notes, sales receipts and
 * statements, with the organization's branding as it stood when the
 * document was issued (the snapshot), so a reprint matches what was sent.
 */
import { and, eq, inArray } from "drizzle-orm";
import { rgb } from "pdf-lib";
import type { DbOrTx } from "@/lib/db/client";
import { attachments, organizations, type OrgProfile } from "@/lib/db/schema/core";
import { contacts, taxJurisdictions, type Address } from "@/lib/db/schema/ledger";
import { getDocument } from "@/lib/commerce/documents";
import { itemBalance } from "@/lib/commerce/open-items";
import { KIND_LABELS } from "@/lib/commerce/states";
import { NotFoundError } from "@/lib/errors";
import { Decimal } from "@/lib/money/decimal";
import { formatDate, formatMoney } from "@/lib/money/format";
import { MUTED, PdfWriter, pdfMoney, pdfSafe } from "@/lib/pdf/core";
import { storage } from "@/lib/storage/storage";
import { openPaymentLink } from "@/lib/integrations/payments/links";
import { AGING_BUCKETS, type Statement } from "./statements";

const money = (v: string | Decimal, currency: string) => pdfMoney(formatMoney(v.toString(), currency, { accounting: true }), currency);

function addressLines(a: Address | null | undefined): string[] {
  if (!a) return [];
  return [a.line1, a.line2, [a.city, a.region, a.postalCode].filter(Boolean).join(", "), a.country].filter((x): x is string => !!x && x.trim() !== "");
}

function hexColor(hex: string | undefined) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? "");
  if (!m) return null;
  return rgb(parseInt(m[1]!, 16) / 255, parseInt(m[2]!, 16) / 255, parseInt(m[3]!, 16) / 255);
}

async function drawBranding(w: PdfWriter, db: DbOrTx, orgId: string, profile: OrgProfile) {
  const accent = hexColor(profile.branding?.accentColor);
  if (accent) {
    w.page.drawRectangle({ x: 0, y: w.height - 6, width: w.width, height: 6, color: accent });
  }
  const logoId = profile.branding?.logoAttachmentId;
  if (!logoId) return;
  const [att] = await db.select().from(attachments).where(and(eq(attachments.orgId, orgId), eq(attachments.id, logoId)));
  if (!att || !/^image\/(png|jpeg)$/.test(att.contentType)) return;
  try {
    const bytes = await storage().get(att.storageKey);
    const img = await w.embedImage(new Uint8Array(bytes), att.contentType);
    if (!img) return;
    const scale = Math.min(120 / img.width, 48 / img.height, 1);
    w.page.drawImage(img, { x: w.width - w.margin - img.width * scale, y: w.height - w.margin - img.height * scale + 6, width: img.width * scale, height: img.height * scale });
  } catch {
    // A missing logo never stops the document.
  }
}

/** Two blocks side by side; returns with y below the taller. */
function columns(w: PdfWriter, left: { title: string; lines: string[] }, right: { title: string; lines: string[] }) {
  const top = w.y;
  const half = w.contentWidth / 2;
  const draw = (block: { title: string; lines: string[] }, x: number) => {
    w.y = top;
    w.text(block.title.toUpperCase(), { size: 7.5, color: MUTED, x });
    for (const l of block.lines) w.text(l, { size: 9.5, x });
    return w.y;
  };
  const a = draw(left, w.margin);
  const b = draw(right, w.margin + half);
  w.y = Math.min(a, b);
}

export async function renderDocumentPdf(db: DbOrTx, orgId: string, documentId: string): Promise<{ bytes: Uint8Array; fileName: string }> {
  const { doc, lines, taxes } = await getDocument(db, orgId, documentId);
  const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
  if (!org) throw new NotFoundError("The organization");
  const [contact] = doc.contactId ? await db.select().from(contacts).where(and(eq(contacts.orgId, orgId), eq(contacts.id, doc.contactId))) : [];
  const profile: OrgProfile = (doc.brandingSnapshot as OrgProfile | null) ?? org.profile ?? {};
  const label = KIND_LABELS[doc.kind];
  const number = doc.number ?? "DRAFT";
  const status = doc.status === "void" ? " — VOID" : doc.status === "draft" ? " — DRAFT" : "";
  const subtitleParts = [`${label} date ${formatDate(doc.issueDate)}`];
  if (doc.dueDate && doc.kind === "invoice") subtitleParts.push(`Due ${formatDate(doc.dueDate)}`);
  if (doc.expiryDate && doc.kind === "estimate") subtitleParts.push(`Valid until ${formatDate(doc.expiryDate)}`);
  const w = await PdfWriter.create(
    { title: `${label} ${number}${status}`, subtitle: subtitleParts.join("  ·  "), org: org.legalName ?? org.name },
    profile.branding?.invoiceFooter ?? org.name,
  );
  await drawBranding(w, db, orgId, profile);

  const from = [org.legalName ?? org.name, ...addressLines(profile.address), profile.email, profile.phone, profile.taxId ? `Tax ID ${profile.taxId}` : undefined].filter((x): x is string => !!x);
  const to = contact ? [contact.displayName, contact.companyName ?? undefined, ...addressLines(doc.billingAddress ?? contact.billingAddress), contact.email ?? undefined].filter((x): x is string => !!x) : [];
  columns(w, { title: doc.kind === "estimate" ? "Prepared for" : "Bill to", lines: to }, { title: "From", lines: from });
  w.space(6);
  const meta = [`Number: ${number}`, `Currency: ${doc.currency}`, doc.reference ? `Your reference: ${doc.reference}` : null].filter(Boolean).join("     ");
  w.text(meta, { size: 8.5, color: MUTED });
  w.space(8);

  const hasDiscount = lines.some((l) => l.discountRate && !Decimal.from(l.discountRate).isZero());
  const cols = hasDiscount
    ? [
        { header: "Description", width: 0.46 },
        { header: "Qty", width: 0.1, align: "right" as const },
        { header: "Price", width: 0.16, align: "right" as const },
        { header: "Disc.", width: 0.1, align: "right" as const },
        { header: "Amount", width: 0.18, align: "right" as const },
      ]
    : [
        { header: "Description", width: 0.54 },
        { header: "Qty", width: 0.12, align: "right" as const },
        { header: "Price", width: 0.16, align: "right" as const },
        { header: "Amount", width: 0.18, align: "right" as const },
      ];
  w.table(
    cols,
    lines.map((l) => {
      const amount = Decimal.from(l.netAmount).add(l.documentDiscount);
      const cells = [
        l.description || "",
        Decimal.from(l.quantity).normalize().toString(),
        money(Decimal.from(l.unitPrice).normalize().toString(), doc.currency),
        ...(hasDiscount ? [l.discountRate ? `${Decimal.from(l.discountRate).mul(100).normalize().toString()}%` : ""] : []),
        money(doc.taxInclusive ? Decimal.from(l.grossAmount).add(l.documentDiscount).toString() : amount.toString(), doc.currency),
      ];
      return { cells };
    }),
  );
  w.space(6);

  // Totals, right-aligned.
  const jurIds = [...new Set(taxes.map((t) => t.jurisdictionId))];
  const jurs = jurIds.length ? await db.select().from(taxJurisdictions).where(and(eq(taxJurisdictions.orgId, orgId), inArray(taxJurisdictions.id, jurIds))) : [];
  const byJur = new Map<string, { name: string; rate: string; amount: Decimal }>();
  for (const t of taxes) {
    if (t.isExempt) continue;
    const key = `${t.jurisdictionId}|${t.rate}`;
    const name = jurs.find((j) => j.id === t.jurisdictionId)?.name ?? "Tax";
    const cur = byJur.get(key) ?? { name, rate: t.rate, amount: Decimal.ZERO };
    cur.amount = cur.amount.add(t.taxAmount);
    byJur.set(key, cur);
  }
  const totals: { label: string; value: string; bold?: boolean }[] = [{ label: "Subtotal", value: money(doc.subtotal, doc.currency) }];
  if (!Decimal.from(doc.discountTotal).isZero()) totals.push({ label: "Discount", value: money(Decimal.from(doc.discountTotal).neg(), doc.currency) });
  for (const j of byJur.values()) {
    totals.push({ label: `${j.name} ${Decimal.from(j.rate).mul(100).normalize().toString()}%${doc.taxInclusive ? " (included)" : ""}`, value: money(j.amount, doc.currency) });
  }
  if (taxes.some((t) => t.isExempt)) totals.push({ label: "Tax-exempt sale", value: money("0", doc.currency) });
  totals.push({ label: "Total", value: money(doc.total, doc.currency), bold: true });
  let due: Decimal | null = null;
  if (doc.kind === "invoice" && doc.status !== "draft" && doc.status !== "void") {
    due = (await itemBalance(db, orgId, doc.id)).txn;
    const paid = Decimal.from(doc.total).sub(due);
    if (!paid.isZero()) totals.push({ label: "Paid and credited", value: money(paid.neg(), doc.currency) });
    totals.push({ label: "Amount due", value: money(due, doc.currency), bold: true });
  }
  w.ensure(totals.length * 14 + 10);
  const labelX = w.margin + w.contentWidth * 0.5;
  for (const t of totals) {
    const font = t.bold ? w.bold : w.font;
    w.text(t.label, { size: 9.5, font, x: labelX, advance: false });
    w.text(t.value, { size: 9.5, font, align: "right" });
  }
  w.space(10);

  if (doc.kind === "invoice" && due && due.isPositive()) {
    const link = await openPaymentLink(db, orgId, doc.id);
    if (link) {
      w.text("Pay online", { size: 9, font: w.bold });
      w.paragraph(link.url, { size: 8.5, color: MUTED });
      w.space(4);
    }
  }
  if (doc.notes) {
    w.text("Notes", { size: 9, font: w.bold });
    w.paragraph(doc.notes, { size: 9 });
    w.space(4);
  }
  if (profile.branding?.paymentInstructions && (doc.kind === "invoice" || doc.kind === "estimate")) {
    w.text("How to pay", { size: 9, font: w.bold });
    w.paragraph(profile.branding.paymentInstructions, { size: 9 });
  }
  const bytes = await w.finish();
  return { bytes, fileName: pdfSafe(`${label} ${number}.pdf`).replace(/[^\w.\- ]/g, "_") };
}

export async function renderStatementPdf(db: DbOrTx, orgId: string, s: Statement): Promise<{ bytes: Uint8Array; fileName: string }> {
  const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
  if (!org) throw new NotFoundError("The organization");
  const profile: OrgProfile = org.profile ?? {};
  const w = await PdfWriter.create(
    { title: `Statement for ${s.contact.displayName}`, subtitle: `${formatDate(s.from)} to ${formatDate(s.to)}  ·  ${s.currency}`, org: org.legalName ?? org.name },
    profile.branding?.invoiceFooter ?? org.name,
  );
  await drawBranding(w, db, orgId, profile);
  columns(
    w,
    { title: "Customer", lines: [s.contact.displayName, ...addressLines(s.contact.billingAddress), s.contact.email ?? ""].filter(Boolean) },
    { title: "From", lines: [org.legalName ?? org.name, ...addressLines(profile.address), profile.email ?? ""].filter(Boolean) },
  );
  w.space(10);
  w.table(
    [
      { header: "Date", width: 0.14 },
      { header: "Reference", width: 0.16 },
      { header: "Description", width: 0.34 },
      { header: "Charges", width: 0.12, align: "right" },
      { header: "Credits", width: 0.12, align: "right" },
      { header: "Balance", width: 0.12, align: "right" },
    ],
    [
      { cells: [formatDate(s.from), "", "Opening balance", "", "", money(s.opening, s.currency)], muted: true },
      ...s.lines.map((l) => ({
        cells: [
          formatDate(l.date),
          l.reference ?? "",
          l.description,
          Decimal.from(l.charge).isZero() ? "" : money(l.charge, s.currency),
          Decimal.from(l.credit).isZero() ? "" : money(l.credit, s.currency),
          money(l.balance, s.currency),
        ],
      })),
      { cells: [formatDate(s.to), "", "Closing balance", money(s.totalCharges, s.currency), money(s.totalCredits, s.currency), money(s.closing, s.currency)], bold: true, ruleAbove: true },
    ],
  );
  w.space(12);
  w.text("Amounts open by age", { size: 9, font: w.bold });
  w.table(
    AGING_BUCKETS.map((b) => ({ header: b, width: 1 / AGING_BUCKETS.length, align: "right" as const })),
    [{ cells: s.aging.map((a) => money(a, s.currency)) }],
  );
  if (profile.branding?.paymentInstructions) {
    w.space(10);
    w.text("How to pay", { size: 9, font: w.bold });
    w.paragraph(profile.branding.paymentInstructions, { size: 9 });
  }
  const bytes = await w.finish();
  return { bytes, fileName: pdfSafe(`Statement ${s.contact.displayName} ${s.to}.pdf`).replace(/[^\w.\- ]/g, "_") };
}
