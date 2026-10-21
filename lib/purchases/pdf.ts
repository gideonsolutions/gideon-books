/** The purchase order as a PDF to send to the vendor. */
import { and, eq, inArray } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import { contacts, items, type Address } from "@/lib/db/schema/ledger";
import { getDocument } from "@/lib/commerce/documents";
import type { Ctx } from "@/lib/context";
import { NotFoundError } from "@/lib/errors";
import { Decimal } from "@/lib/money/decimal";
import { formatDate, formatMoney } from "@/lib/money/format";
import { MUTED, PdfWriter, pdfMoney } from "@/lib/pdf/core";

function addressLines(a: Address | null | undefined): string[] {
  if (!a) return [];
  return [a.line1, a.line2, [a.city, a.region, a.postalCode].filter(Boolean).join(", "), a.country].filter((x): x is string => !!x && x.trim() !== "");
}

export async function purchaseOrderPdf(db: DbOrTx, ctx: Ctx, id: string): Promise<{ bytes: Uint8Array; fileName: string }> {
  const { doc, lines } = await getDocument(db, ctx.orgId, id);
  if (doc.kind !== "purchase_order") throw new NotFoundError("The purchase order");
  const [vendor] = doc.contactId ? await db.select().from(contacts).where(and(eq(contacts.orgId, ctx.orgId), eq(contacts.id, doc.contactId))) : [];
  const itemIds = [...new Set(lines.map((l) => l.itemId).filter(Boolean))] as string[];
  const itemRows = itemIds.length ? await db.select().from(items).where(and(eq(items.orgId, ctx.orgId), inArray(items.id, itemIds))) : [];
  const profile = doc.brandingSnapshot ?? ctx.org.profile;
  const money = (v: string) => pdfMoney(formatMoney(v, doc.currency), doc.currency);
  const w = await PdfWriter.create(
    { title: `Purchase order ${doc.number ?? "(draft)"}`, subtitle: `Dated ${formatDate(doc.issueDate)}${doc.expiryDate ? ` · needed by ${formatDate(doc.expiryDate)}` : ""}`, org: ctx.org.legalName ?? ctx.org.name },
    profile.branding?.invoiceFooter,
  );
  const top = w.y;
  w.text("From", { size: 8, color: MUTED });
  w.text(ctx.org.legalName ?? ctx.org.name, { size: 10 });
  for (const l of addressLines(profile.address)) w.text(l, { size: 9 });
  if (profile.email) w.text(profile.email, { size: 9 });
  const leftEnd = w.y;
  w.y = top;
  const x = w.margin + w.contentWidth / 2;
  w.text("To", { size: 8, color: MUTED, x });
  w.text(vendor?.companyName ?? vendor?.displayName ?? "", { size: 10, x });
  for (const l of addressLines(vendor?.billingAddress)) w.text(l, { size: 9, x });
  if (vendor?.email) w.text(vendor.email, { size: 9, x });
  w.y = Math.min(leftEnd, w.y) - 10;
  if (doc.reference) {
    w.text(`Your reference: ${doc.reference}`, { size: 9 });
    w.space(4);
  }
  w.table(
    [
      { header: "Item", width: 0.46 },
      { header: "Qty", width: 0.12, align: "right" },
      { header: "Unit price", width: 0.2, align: "right" },
      { header: "Amount", width: 0.22, align: "right" },
    ],
    [
      ...lines.map((l) => {
        const it = itemRows.find((i) => i.id === l.itemId);
        const name = it ? `${it.name}${it.sku ? ` (${it.sku})` : ""}${l.description && l.description !== it.name ? ` — ${l.description}` : ""}` : l.description;
        return { cells: [name, `${Decimal.from(l.quantity).normalize().toString()}${it ? ` ${it.unit}` : ""}`, money(Decimal.from(l.unitPrice).normalize().toString()), money(l.netAmount)] };
      }),
      { cells: ["Subtotal", "", "", money(Decimal.from(doc.subtotal).sub(doc.discountTotal).toString())], ruleAbove: true },
      { cells: ["Tax", "", "", money(doc.taxTotal)] },
      { cells: ["Total", "", "", money(doc.total)], bold: true },
    ],
  );
  if (doc.notes) {
    w.space(10);
    w.paragraph(doc.notes, { size: 9 });
  }
  w.space(10);
  w.paragraph("Please quote this purchase order number on your delivery note and invoice.", { size: 8.5, color: MUTED });
  return { bytes: await w.finish(), fileName: `purchase-order-${doc.number ?? doc.id}.pdf` };
}
