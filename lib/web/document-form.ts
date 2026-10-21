/**
 * Server side of the document editor: the options it needs, turning its
 * form data into a DocumentInput, and turning a saved document back into a
 * draft for editing.
 */
import { and, asc, eq } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import { contacts, items, paymentTerms, taxCodes } from "@/lib/db/schema/ledger";
import type { DocumentKind } from "@/lib/db/schema/commerce";
import type { Ctx } from "@/lib/context";
import { loadTaxComponents } from "@/lib/tax/config";
import { Decimal } from "@/lib/money/decimal";
import { accountOptions, currencyOptions, dimensionOptions, locationOptions, moneyAccountOptions, contactOptions } from "./options";
import type { DocumentInput, Document, DocumentLine } from "@/lib/commerce/documents";
import type { DocumentDraft, DocumentFormProps, TaxCodeChoice } from "@/components/commerce/document-form";
import { str, bool } from "./actions";

export async function documentFormOptions(db: DbOrTx, ctx: Ctx, side: "sales" | "purchases", date: string) {
  const contactRows = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.orgId, ctx.orgId), eq(contacts.isArchived, false), side === "sales" ? eq(contacts.isCustomer, true) : eq(contacts.isArchived, false)))
    .orderBy(asc(contacts.displayName));
  const contactChoices = contactRows
    .filter((c) => (side === "sales" ? c.isCustomer : c.isVendor || c.isEmployee))
    .map((c) => ({ value: c.id, label: c.displayName + (c.isVendor || c.isCustomer ? "" : " (employee)"), currency: c.currency, taxExempt: c.taxExempt, termsId: c.paymentTermsId }));
  const itemRows = await db.select().from(items).where(and(eq(items.orgId, ctx.orgId), eq(items.isArchived, false))).orderBy(asc(items.name));
  const codeRows = await db.select().from(taxCodes).where(and(eq(taxCodes.orgId, ctx.orgId), eq(taxCodes.isArchived, false))).orderBy(asc(taxCodes.name));
  const taxChoices: TaxCodeChoice[] = [];
  for (const c of codeRows) {
    try {
      const { components } = await loadTaxComponents(db, ctx.orgId, c.id, date, side);
      taxChoices.push({
        id: c.id,
        name: c.name,
        components: components.map((x) => ({ jurisdictionId: x.jurisdictionId, taxRateId: x.taxRateId, rate: x.rate.toString(), sequence: x.sequence, isCompound: x.isCompound, isRecoverable: !!x.isRecoverable })),
      });
    } catch {
      // No rate in effect on this date: offered, but the server will say so on save.
      taxChoices.push({ id: c.id, name: `${c.name} (no rate on ${date})`, components: [] });
    }
  }
  const terms = await db.select().from(paymentTerms).where(and(eq(paymentTerms.orgId, ctx.orgId), eq(paymentTerms.isArchived, false))).orderBy(asc(paymentTerms.daysDue));
  return {
    contacts: contactChoices,
    items: itemRows.map((i) => ({
      id: i.id,
      name: i.name,
      kind: i.kind,
      description: i.description,
      price: side === "sales" ? i.salePrice : i.purchaseCost,
      taxCodeId: side === "sales" ? i.saleTaxCodeId : i.purchaseTaxCodeId,
      accountId: side === "sales" ? i.incomeAccountId : i.kind === "stock" ? i.inventoryAccountId : i.expenseAccountId,
      unit: i.unit,
    })),
    accounts: await accountOptions(db, ctx.orgId, side === "sales" ? { types: ["income", "liability", "equity"], excludeControl: true } : { types: ["expense", "asset", "liability", "equity"], excludeControl: true }),
    taxCodes: taxChoices,
    terms: terms.map((t) => ({ value: t.id, label: t.name })),
    currencies: currencyOptions().filter((c) => c.value !== ctx.org.baseCurrency),
    baseCurrency: ctx.org.baseCurrency,
    dims: await dimensionOptions(db, ctx.orgId),
    stockLocations: await locationOptions(db, ctx.orgId),
    cashAccounts: await moneyAccountOptions(db, ctx.orgId),
    customers: side === "purchases" ? await contactOptions(db, ctx.orgId, "customer") : undefined,
    taxRounding: ctx.org.taxRounding,
  } satisfies Partial<DocumentFormProps>;
}

/** Parse the document editor's form data. */
export function parseDocumentForm(fd: FormData, kind: DocumentKind): DocumentInput {
  const count = Number(fd.get("lineCount") ?? 0);
  const lines: DocumentInput["lines"] = [];
  for (let i = 0; i < Math.min(count, 1000); i++) {
    const p = (k: string) => str(fd, `lines.${i}.${k}`);
    const line = {
      lineType: (p("lineType") ?? "item") as "item" | "shipping",
      itemId: p("itemId"),
      description: p("description"),
      quantity: p("quantity"),
      unitPrice: p("unitPrice"),
      discountPercent: p("discountPercent"),
      accountId: p("accountId"),
      taxCodeId: p("taxCodeId"),
      serviceDate: p("serviceDate"),
      projectId: p("projectId"),
      classId: p("classId"),
      departmentId: p("departmentId"),
      locationId: p("locationId"),
      fundId: p("fundId"),
      inventoryLocationId: p("inventoryLocationId"),
      billableCustomerId: p("billableCustomerId"),
      sourceLineId: p("sourceLineId"),
      returnOfLineId: p("returnOfLineId"),
    };
    // Skip rows left completely empty.
    if (!line.itemId && !line.description && !line.unitPrice && line.lineType === "item") continue;
    lines.push(line);
  }
  return {
    kind,
    contactId: str(fd, "contactId") ?? "",
    issueDate: str(fd, "issueDate") ?? "",
    postingDate: str(fd, "postingDate"),
    dueDate: str(fd, "dueDate"),
    expiryDate: str(fd, "expiryDate"),
    paymentTermsId: str(fd, "paymentTermsId"),
    currency: str(fd, "currency"),
    fxRate: str(fd, "fxRate"),
    taxInclusive: bool(fd, "taxInclusive"),
    discountType: (str(fd, "discountType") as "percent" | "amount" | null) ?? null,
    discountValue: str(fd, "discountValue"),
    reference: str(fd, "reference"),
    memo: str(fd, "memo"),
    notes: str(fd, "notes"),
    cashAccountId: str(fd, "cashAccountId"),
    inventoryLocationId: str(fd, "inventoryLocationId"),
    isReimbursement: bool(fd, "isReimbursement"),
    lines,
  };
}

/** A saved document as a draft for the editor. */
export function draftFromDocument(doc: Document, lines: DocumentLine[], baseCurrency: string): DocumentDraft {
  return {
    contactId: doc.contactId ?? "",
    issueDate: doc.issueDate,
    postingDate: doc.postingDate ?? "",
    dueDate: doc.dueDate ?? "",
    expiryDate: doc.expiryDate ?? "",
    paymentTermsId: doc.paymentTermsId ?? "",
    currency: doc.currency === baseCurrency ? "" : doc.currency,
    fxRate: doc.currency === baseCurrency || !doc.exchangeRateId ? "" : Decimal.from(doc.fxRate).normalize().toString(),
    taxInclusive: doc.taxInclusive,
    discountType: doc.discountType ?? "",
    discountValue: doc.discountValue ? Decimal.from(doc.discountValue).normalize().toString() : "",
    reference: doc.reference ?? "",
    memo: doc.memo ?? "",
    notes: doc.notes ?? "",
    cashAccountId: doc.cashAccountId ?? "",
    inventoryLocationId: doc.inventoryLocationId ?? "",
    isReimbursement: doc.isReimbursement,
    lines: lines.map((l) => ({
      lineType: l.lineType,
      itemId: l.itemId ?? "",
      description: l.description,
      quantity: Decimal.from(l.quantity).normalize().toString(),
      unitPrice: Decimal.from(l.unitPrice).normalize().toString(),
      discountPercent: l.discountRate ? Decimal.from(l.discountRate).mul(100).normalize().toString() : "",
      accountId: l.accountId ?? "",
      taxCodeId: l.taxCodeId ?? "",
      serviceDate: l.serviceDate ?? "",
      projectId: l.projectId ?? "",
      classId: l.classId ?? "",
      departmentId: l.departmentId ?? "",
      locationId: l.locationId ?? "",
      fundId: l.fundId ?? "",
      inventoryLocationId: l.inventoryLocationId ?? "",
      billableCustomerId: l.billableCustomerId ?? "",
      sourceLineId: l.sourceLineId ?? "",
      returnOfLineId: l.returnOfLineId ?? "",
    })),
  };
}

export function emptyDraft(today: string): DocumentDraft {
  return {
    contactId: "",
    issueDate: today,
    postingDate: "",
    dueDate: "",
    expiryDate: "",
    paymentTermsId: "",
    currency: "",
    fxRate: "",
    taxInclusive: false,
    discountType: "",
    discountValue: "",
    reference: "",
    memo: "",
    notes: "",
    cashAccountId: "",
    inventoryLocationId: "",
    isReimbursement: false,
    lines: [],
  };
}
