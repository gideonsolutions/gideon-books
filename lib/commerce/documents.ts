/**
 * Sales and purchase documents: drafts, issuing (posting), voiding,
 * conversion, write-offs.
 *
 * Issuing posts one entry for the document (dated its posting date) and, for
 * stock items, the stock movements with a separate cost-of-goods entry.
 * Receivable and payable documents become open items settled by payments
 * and credits (settlements.ts). Voiding reverses everything the document
 * posted, on the void date; a document with payments or credits applied must
 * have them removed first, or be corrected with a credit note instead.
 */
import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import { getDb, withTransaction, type DbOrTx, type Tx } from "@/lib/db/client";
import { contacts, items, accounts, paymentTerms, journalEntries, type EntryKind } from "@/lib/db/schema/ledger";
import { documentLines, documentLineTaxes, documents, settlements, type DocumentKind } from "@/lib/db/schema/commerce";
import { itemCosts, stockMoves } from "@/lib/db/schema/inventory";
import { organizations } from "@/lib/db/schema/core";
import { audit } from "@/lib/audit";
import { requirePermission, type Ctx } from "@/lib/context";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { Decimal } from "@/lib/money/decimal";
import { isCurrency, minorUnits } from "@/lib/money/currency";
import { addDays, assertIsoDate, isIsoDate, todayIn } from "@/lib/dates";
import { findRate, resolveRate, type ResolvedRate } from "@/lib/fx/rates";
import { loadTaxComponentsCached } from "@/lib/tax/config";
import type { TaxComponent } from "@/lib/tax/calculate";
import { postEntry, reverseEntryInternal, type LineInput } from "@/lib/ledger/posting";
import { systemAccountId } from "@/lib/ledger/accounts";
import { nextNumber } from "@/lib/ledger/sequences";
import { defaultLocationId, issueStock, receiveStock, reverseMove } from "@/lib/inventory/stock";
import { computeDocument, ComputeError, type ComputedDocument } from "./compute";
import { POSTING_KINDS, SALES_KINDS, KIND_LABELS, canTransition } from "./states";
import { settle } from "./settlements";
import { itemBalance } from "./open-items";
import { planPoMatching, recordPoMatches, unwindPoMatches, type PoMatchPlan } from "@/lib/purchases/matching";

export type Document = typeof documents.$inferSelect;
export type DocumentLine = typeof documentLines.$inferSelect;
export type DocumentLineTax = typeof documentLineTaxes.$inferSelect;

export interface DocumentLineInput {
  lineType?: "item" | "shipping";
  itemId?: string | null;
  description?: string | null;
  quantity?: string | null;
  unitPrice?: string | null;
  /** Percent, e.g. "10" for 10%. */
  discountPercent?: string | null;
  accountId?: string | null;
  taxCodeId?: string | null;
  serviceDate?: string | null;
  projectId?: string | null;
  classId?: string | null;
  departmentId?: string | null;
  locationId?: string | null;
  fundId?: string | null;
  trustComponent?: "principal" | "income" | null;
  beneficiaryId?: string | null;
  inventoryLocationId?: string | null;
  billableCustomerId?: string | null;
  sourceLineId?: string | null;
  returnOfLineId?: string | null;
}

export interface DocumentInput {
  kind: DocumentKind;
  contactId: string;
  issueDate: string;
  postingDate?: string | null;
  dueDate?: string | null;
  expiryDate?: string | null;
  paymentTermsId?: string | null;
  currency?: string | null;
  fxRate?: string | null;
  taxInclusive?: boolean;
  discountType?: "percent" | "amount" | null;
  discountValue?: string | null;
  reference?: string | null;
  memo?: string | null;
  notes?: string | null;
  billingAddress?: Document["billingAddress"];
  shippingAddress?: Document["shippingAddress"];
  cashAccountId?: string | null;
  inventoryLocationId?: string | null;
  isOpeningBalance?: boolean;
  isReimbursement?: boolean;
  sourceDocumentId?: string | null;
  recurringTemplateId?: string | null;
  lines: DocumentLineInput[];
}

const SIDE = (kind: DocumentKind) => (SALES_KINDS.includes(kind) ? "sales" : "purchases") as "sales" | "purchases";

function managePermission(kind: DocumentKind) {
  return SIDE(kind) === "sales" ? "sales.manage" : "purchases.manage";
}

function cleanDecimal(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const t = v.replace(/[,\s$]/g, "").trim();
  return t === "" ? null : t;
}

interface Resolved {
  contact: typeof contacts.$inferSelect;
  currency: string;
  rate: ResolvedRate;
  computed: ComputedDocument;
  lines: (DocumentLineInput & { accountId: string; quantity: string; unitPrice: string; discountRate: string | null; components: TaxComponent[]; item: typeof items.$inferSelect | null })[];
  dueDate: string | null;
  postingDate: string;
}

/** Validate a document and compute it as it would post on its posting date. */
async function resolveDocument(db: DbOrTx | Tx, ctx: Ctx, input: DocumentInput, opts: { forPosting: boolean }): Promise<Resolved> {
  const fields: Record<string, string> = {};
  const side = SIDE(input.kind);
  if (!isIsoDate(input.issueDate)) fields.issueDate = "Enter the document date.";
  if (input.postingDate && !isIsoDate(input.postingDate)) fields.postingDate = "Enter a valid date.";
  if (input.dueDate && !isIsoDate(input.dueDate)) fields.dueDate = "Enter a valid date.";
  if (input.dueDate && isIsoDate(input.issueDate) && input.dueDate < input.issueDate) fields.dueDate = "The due date is before the document date.";
  if (!input.contactId) fields.contactId = side === "sales" ? "Choose a customer." : "Choose a vendor.";
  if (input.lines.length === 0) fields.lines = "Add at least one line.";
  if (input.lines.length > 1000) fields.lines = "A document can have at most 1,000 lines.";
  if (Object.keys(fields).length) throw new ValidationError("Check the document.", fields);

  const [contact] = await db.select().from(contacts).where(and(eq(contacts.orgId, ctx.orgId), eq(contacts.id, input.contactId)));
  if (!contact) throw new ValidationError("That contact does not exist.", { contactId: "Not found." });
  if (side === "sales" && !contact.isCustomer) throw new ValidationError(`${contact.displayName} is not marked as a customer.`, { contactId: "Not a customer." });
  if (side === "purchases" && !contact.isVendor && !(input.isReimbursement && contact.isEmployee)) {
    throw new ValidationError(`${contact.displayName} is not marked as a vendor.`, { contactId: "Not a vendor." });
  }
  const currency = input.currency || contact.currency || ctx.org.baseCurrency;
  if (!isCurrency(currency)) throw new ValidationError("Unknown currency.", { currency: "Pick a currency." });
  if (contact.currency && currency !== contact.currency && currency !== ctx.org.baseCurrency) {
    throw new ValidationError(`${contact.displayName} is billed in ${contact.currency}.`, { currency: `Use ${contact.currency}.` });
  }
  const postingDate = input.postingDate || input.issueDate;
  const rate =
    currency === ctx.org.baseCurrency
      ? { rate: Decimal.ONE, exchangeRateId: null, rateDate: postingDate, source: "identity" }
      : opts.forPosting || input.fxRate
        ? await resolveRate(db, ctx, currency, postingDate, cleanDecimal(input.fxRate))
        : ((await findRate(db, ctx.orgId, currency, ctx.org.baseCurrency, postingDate)) ?? {
            rate: Decimal.ONE,
            exchangeRateId: null,
            rateDate: postingDate,
            source: "pending",
          });

  if ((input.kind === "sales_receipt" || input.kind === "expense") && !input.cashAccountId) {
    throw new ValidationError(input.kind === "expense" ? "Choose what it was paid from." : "Choose where the money was deposited.", { cashAccountId: "Required." });
  }
  if (input.cashAccountId) {
    const [acc] = await db.select().from(accounts).where(and(eq(accounts.orgId, ctx.orgId), eq(accounts.id, input.cashAccountId)));
    if (!acc || !["bank", "cash", "clearing", "credit_card"].includes(acc.subtype)) {
      throw new ValidationError("Choose a bank, cash, clearing or credit-card account.", { cashAccountId: "Not a money account." });
    }
    if (acc.currency && acc.currency !== currency) throw new ValidationError(`That account is kept in ${acc.currency}.`, { cashAccountId: "Currency differs." });
  }

  const itemIds = [...new Set(input.lines.map((l) => l.itemId).filter(Boolean))] as string[];
  const itemRows = itemIds.length ? await db.select().from(items).where(and(eq(items.orgId, ctx.orgId), inArray(items.id, itemIds))) : [];
  const itemMap = new Map(itemRows.map((i) => [i.id, i]));
  const taxLookup = await loadTaxComponentsCached(db, ctx.orgId, input.issueDate, side);
  const isOpening = !!input.isOpeningBalance;
  const openingEquity = isOpening ? await systemAccountIdRead(db, ctx, "opening_balance_equity") : null;

  const lines: Resolved["lines"] = [];
  const lineFields: Record<string, string> = {};
  for (let i = 0; i < input.lines.length; i++) {
    const l = input.lines[i]!;
    const item = l.itemId ? (itemMap.get(l.itemId) ?? null) : null;
    if (l.itemId && !item) {
      lineFields[`lines.${i}.itemId`] = "Item not found.";
      continue;
    }
    if (item?.isArchived) lineFields[`lines.${i}.itemId`] = `${item.name} is archived.`;
    const quantity = cleanDecimal(l.quantity) ?? "1";
    const unitPrice = cleanDecimal(l.unitPrice) ?? (side === "sales" ? (item?.salePrice ?? "0") : (item?.purchaseCost ?? "0"));
    if (!Decimal.isValid(quantity)) lineFields[`lines.${i}.quantity`] = "Not a number.";
    if (!Decimal.isValid(unitPrice)) lineFields[`lines.${i}.unitPrice`] = "Not a number.";
    let discountRate: string | null = null;
    const dp = cleanDecimal(l.discountPercent);
    if (dp) {
      const d = Decimal.tryFrom(dp);
      if (!d || d.isNegative() || d.gt(100)) lineFields[`lines.${i}.discountPercent`] = "0–100.";
      else discountRate = d.div(100, 8, "half_up").toString();
    }
    if (item?.kind === "stock" && Decimal.tryFrom(quantity)?.isNegative()) {
      lineFields[`lines.${i}.quantity`] = "Use a credit note or vendor credit to return stock.";
    }
    if (l.serviceDate && !isIsoDate(l.serviceDate)) lineFields[`lines.${i}.serviceDate`] = "Invalid date.";
    // The account the line posts to.
    let accountId = l.accountId || null;
    if (isOpening) accountId = openingEquity;
    else if (side === "sales") {
      accountId ??= item?.incomeAccountId ?? contact.defaultIncomeAccountId ?? null;
      if (!accountId) accountId = await systemAccountIdRead(db, ctx, l.lineType === "shipping" ? "shipping_income" : "service_income");
    } else {
      if (item?.kind === "stock") accountId = item.inventoryAccountId;
      accountId ??= item?.expenseAccountId ?? contact.defaultExpenseAccountId ?? null;
      if (!accountId) accountId = await systemAccountIdRead(db, ctx, "general_expense");
    }
    let components: TaxComponent[] = [];
    const taxCodeId = l.taxCodeId ?? null;
    if (taxCodeId && !isOpening) {
      try {
        components = (await taxLookup(taxCodeId)).components;
      } catch (e) {
        if (e instanceof ValidationError) {
          lineFields[`lines.${i}.taxCodeId`] = e.message;
          continue;
        }
        throw e;
      }
    }
    lines.push({ ...l, accountId: accountId!, quantity, unitPrice, discountRate, components, item });
  }
  if (Object.keys(lineFields).length) throw new ValidationError("Check the lines.", lineFields);

  // Accounts on lines must exist, be active, and suit the side.
  const accIds = [...new Set(lines.map((l) => l.accountId))];
  const accRows = await db.select().from(accounts).where(and(eq(accounts.orgId, ctx.orgId), inArray(accounts.id, accIds)));
  const accMap = new Map(accRows.map((a) => [a.id, a]));
  lines.forEach((l, i) => {
    const a = accMap.get(l.accountId);
    if (!a) lineFields[`lines.${i}.accountId`] = "Account not found.";
    else if (a.isArchived) lineFields[`lines.${i}.accountId`] = `${a.name} is archived.`;
    else if (a.control && a.control !== "inventory" && a.control !== "fixed_assets") lineFields[`lines.${i}.accountId`] = `${a.name} is a control account.`;
    else if (a.control === "inventory" && l.item?.kind !== "stock") lineFields[`lines.${i}.accountId`] = "Only stock items post to an inventory account.";
  });
  if (Object.keys(lineFields).length) throw new ValidationError("Check the line accounts.", lineFields);

  const exempt = side === "sales" && contact.taxExempt;
  let computed: ComputedDocument;
  try {
    computed = computeDocument({
      currency,
      taxInclusive: !!input.taxInclusive,
      rounding: ctx.org.taxRounding,
      discountType: input.discountType ?? null,
      discountValue: cleanDecimal(input.discountValue),
      lines: lines.map((l, i) => ({
        key: String(i),
        lineType: l.lineType ?? "item",
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        discountRate: l.discountRate,
        taxComponents: l.components,
        exempt,
      })),
    });
  } catch (e) {
    if (e instanceof ComputeError) throw new ValidationError(e.message, { [e.field]: e.message });
    throw e;
  }
  if (computed.total.isNegative()) throw new ValidationError("The total cannot be negative. Use a credit note for a credit.", { lines: "Negative total." });

  let dueDate = input.dueDate || null;
  if (!dueDate && (input.kind === "invoice" || input.kind === "bill")) {
    const termsId = input.paymentTermsId || contact.paymentTermsId;
    if (termsId) {
      const [t] = await db.select().from(paymentTerms).where(and(eq(paymentTerms.orgId, ctx.orgId), eq(paymentTerms.id, termsId)));
      if (t) dueDate = addDays(input.issueDate, t.daysDue);
    }
    dueDate ??= input.issueDate;
  }
  return { contact, currency, rate, computed, lines, dueDate, postingDate };
}

async function systemAccountIdRead(db: DbOrTx | Tx, ctx: Ctx, key: Parameters<typeof systemAccountId>[2]): Promise<string> {
  // systemAccountId may create the account; that needs a transaction.
  if ("rollback" in db) return systemAccountId(db as Tx, ctx.orgId, key);
  return withTransaction((tx) => systemAccountId(tx, ctx.orgId, key));
}

async function writeLines(tx: Tx, ctx: Ctx, docId: string, r: Resolved) {
  await tx.delete(documentLines).where(and(eq(documentLines.orgId, ctx.orgId), eq(documentLines.documentId, docId)));
  if (!r.lines.length) return [];
  const inserted = await tx
    .insert(documentLines)
    .values(
      r.lines.map((l, i) => {
        const c = r.computed.lines[i]!;
        return {
          orgId: ctx.orgId,
          documentId: docId,
          lineNo: i + 1,
          lineType: l.lineType ?? "item",
          itemId: l.itemId || null,
          description: l.description?.trim() || l.item?.description || l.item?.name || "",
          quantity: Decimal.from(l.quantity).toString(),
          unitPrice: Decimal.from(l.unitPrice).toString(),
          discountRate: l.discountRate,
          documentDiscount: c.documentDiscount.toString(),
          accountId: l.accountId,
          taxCodeId: l.taxCodeId || null,
          netAmount: c.net.toString(),
          taxAmount: c.tax.toString(),
          grossAmount: c.gross.toString(),
          serviceDate: l.serviceDate || null,
          projectId: l.projectId || null,
          classId: l.classId || null,
          departmentId: l.departmentId || null,
          locationId: l.locationId || null,
          fundId: l.fundId || null,
          trustComponent: l.trustComponent || null,
          beneficiaryId: l.beneficiaryId || null,
          inventoryLocationId: l.inventoryLocationId || null,
          billableCustomerId: l.billableCustomerId || null,
          sourceLineId: l.sourceLineId || null,
          returnOfLineId: l.returnOfLineId || null,
        };
      }),
    )
    .returning();
  inserted.sort((a, b) => a.lineNo - b.lineNo);
  const taxRows = inserted.flatMap((row, i) =>
    r.computed.lines[i]!.taxes.map((t) => ({
      orgId: ctx.orgId,
      documentId: docId,
      documentLineId: row.id,
      jurisdictionId: t.component.jurisdictionId,
      taxRateId: t.component.taxRateId,
      rate: t.component.rate.toString(),
      sequence: t.component.sequence,
      isCompound: t.component.isCompound,
      taxableAmount: t.taxable.toString(),
      taxAmount: t.amount.toString(),
      isRecoverable: !!t.component.isRecoverable,
      isExempt: t.exempt,
      accountId: t.component.accountId,
    })),
  );
  if (taxRows.length) await tx.insert(documentLineTaxes).values(taxRows);
  return inserted;
}

function headerValues(ctx: Ctx, input: DocumentInput, r: Resolved) {
  return {
    contactId: input.contactId,
    issueDate: input.issueDate,
    postingDate: input.postingDate || null,
    dueDate: r.dueDate,
    expiryDate: input.expiryDate || null,
    paymentTermsId: input.paymentTermsId || r.contact.paymentTermsId || null,
    currency: r.currency,
    fxRate: r.rate.rate.toString(),
    exchangeRateId: r.rate.exchangeRateId,
    taxInclusive: !!input.taxInclusive,
    discountType: input.discountType ?? null,
    discountValue: cleanDecimal(input.discountValue),
    subtotal: r.computed.subtotal.toString(),
    discountTotal: r.computed.discountTotal.toString(),
    taxTotal: r.computed.taxTotal.toString(),
    total: r.computed.total.toString(),
    baseTotal: r.computed.total.mul(r.rate.rate).round(minorUnits(ctx.org.baseCurrency), "half_up").toString(),
    reference: input.reference?.trim() || null,
    memo: input.memo?.trim() || null,
    notes: input.notes?.trim() || null,
    billingAddress: input.billingAddress ?? r.contact.billingAddress ?? null,
    shippingAddress: input.shippingAddress ?? r.contact.shippingAddress ?? null,
    cashAccountId: input.cashAccountId || null,
    inventoryLocationId: input.inventoryLocationId || null,
    isOpeningBalance: !!input.isOpeningBalance,
    isReimbursement: !!input.isReimbursement,
    sourceDocumentId: input.sourceDocumentId || null,
    recurringTemplateId: input.recurringTemplateId || null,
  };
}

/** Create or update a draft. */
export async function saveDraft(ctx: Ctx, input: DocumentInput, id?: string | null): Promise<Document> {
  requirePermission(ctx, managePermission(input.kind));
  return withTransaction(async (tx) => {
    const r = await resolveDocument(tx, ctx, input, { forPosting: false });
    let doc: Document;
    if (id) {
      const [before] = await tx
        .select()
        .from(documents)
        .where(and(eq(documents.orgId, ctx.orgId), eq(documents.id, id)))
        .for("update");
      if (!before) throw new NotFoundError("The document");
      if (before.kind !== input.kind) throw new ConflictError("A document's kind cannot change.", "kind_fixed");
      const editable = before.status === "draft" || ((before.kind === "estimate" || before.kind === "purchase_order") && ["sent", "issued", "expired", "declined"].includes(before.status));
      if (before.kind === "purchase_order" && before.status !== "draft") {
        // Receipts and bills point at the order's lines; once anything is received or billed its lines are fixed.
        const [used] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(documentLines)
          .where(and(eq(documentLines.orgId, ctx.orgId), eq(documentLines.documentId, id), sql`(${documentLines.receivedQuantity} > 0 or ${documentLines.billedQuantity} > 0)`));
        if ((used?.n ?? 0) > 0) {
          throw new ConflictError("Goods have been received or billed against this purchase order, so its lines can no longer change. Close it and raise a new order for the difference.", "po_in_use");
        }
      }
      if (!editable) throw new ConflictError(`${KIND_LABELS[before.kind]} ${before.number ?? ""} is ${before.status}; posted documents cannot be edited. Void it or issue a credit.`, "not_editable");
      [doc] = (await tx
        .update(documents)
        .set({ ...headerValues(ctx, input, r), updatedAt: new Date() })
        .where(eq(documents.id, id))
        .returning()) as [Document];
      await writeLines(tx, ctx, id, r);
      await audit(tx, ctx, { action: "document.updated", entityType: "document", entityId: id, metadata: { kind: input.kind, total: r.computed.total.toString() } });
    } else {
      [doc] = (await tx
        .insert(documents)
        .values({ orgId: ctx.orgId, kind: input.kind, side: SIDE(input.kind), status: "draft", createdBy: ctx.actor.userId, ...headerValues(ctx, input, r) })
        .returning()) as [Document];
      await writeLines(tx, ctx, doc.id, r);
      await audit(tx, ctx, { action: "document.created", entityType: "document", entityId: doc.id, metadata: { kind: input.kind, total: r.computed.total.toString() } });
    }
    return doc;
  });
}

export async function deleteDraft(ctx: Ctx, id: string): Promise<void> {
  await withTransaction(async (tx) => {
    const [d] = await tx
      .select()
      .from(documents)
      .where(and(eq(documents.orgId, ctx.orgId), eq(documents.id, id)))
      .for("update");
    if (!d) throw new NotFoundError("The document");
    requirePermission(ctx, managePermission(d.kind));
    if (d.status !== "draft" && !(d.kind === "estimate" || d.kind === "purchase_order")) {
      throw new ConflictError("Only drafts can be deleted; void a posted document instead.", "not_draft");
    }
    if (d.kind === "purchase_order" && d.status !== "draft") throw new ConflictError("Cancel an issued purchase order instead of deleting it.", "not_draft");
    await tx.delete(documents).where(eq(documents.id, id));
    await audit(tx, ctx, { action: "document.deleted", entityType: "document", entityId: id, before: { kind: d.kind, number: d.number, total: d.total } });
  });
}

export function inputFromDocument(doc: Document, lines: DocumentLine[]): DocumentInput {
  return {
    kind: doc.kind,
    contactId: doc.contactId!,
    issueDate: doc.issueDate,
    postingDate: doc.postingDate,
    dueDate: doc.dueDate,
    expiryDate: doc.expiryDate,
    paymentTermsId: doc.paymentTermsId,
    currency: doc.currency,
    fxRate: null,
    taxInclusive: doc.taxInclusive,
    discountType: doc.discountType,
    discountValue: doc.discountValue,
    reference: doc.reference,
    memo: doc.memo,
    notes: doc.notes,
    billingAddress: doc.billingAddress,
    shippingAddress: doc.shippingAddress,
    cashAccountId: doc.cashAccountId,
    inventoryLocationId: doc.inventoryLocationId,
    isOpeningBalance: doc.isOpeningBalance,
    isReimbursement: doc.isReimbursement,
    sourceDocumentId: doc.sourceDocumentId,
    recurringTemplateId: doc.recurringTemplateId,
    lines: lines.map((l) => ({
      lineType: l.lineType,
      itemId: l.itemId,
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discountPercent: l.discountRate ? Decimal.from(l.discountRate).mul(100).normalize().toString() : null,
      accountId: l.accountId,
      taxCodeId: l.taxCodeId,
      serviceDate: l.serviceDate,
      projectId: l.projectId,
      classId: l.classId,
      departmentId: l.departmentId,
      locationId: l.locationId,
      fundId: l.fundId,
      trustComponent: l.trustComponent,
      beneficiaryId: l.beneficiaryId,
      inventoryLocationId: l.inventoryLocationId,
      billableCustomerId: l.billableCustomerId,
      sourceLineId: l.sourceLineId,
      returnOfLineId: l.returnOfLineId,
    })),
  };
}

const CONTROL_KEY: Partial<Record<DocumentKind, "accounts_receivable" | "accounts_payable">> = {
  invoice: "accounts_receivable",
  credit_note: "accounts_receivable",
  write_off: "accounts_receivable",
  bill: "accounts_payable",
  vendor_credit: "accounts_payable",
};

/** +1 when the document's lines are credits (income on an invoice), −1 when debits (expense on a bill). */
function lineSign(kind: DocumentKind): 1 | -1 {
  return kind === "invoice" || kind === "sales_receipt" || kind === "vendor_credit" ? 1 : -1;
}

/**
 * Issue a draft: number it, compute it at its posting date's rates, post it,
 * and move stock. Estimates are marked sent; purchase orders issued.
 */
export async function issueDocument(ctx: Ctx, id: string, opts: { idempotencyKey?: string | null; allowOverBilling?: boolean } = {}): Promise<Document> {
  return withTransaction(async (tx) => {
    const [doc] = await tx
      .select()
      .from(documents)
      .where(and(eq(documents.orgId, ctx.orgId), eq(documents.id, id)))
      .for("update");
    if (!doc) throw new NotFoundError("The document");
    const side = SIDE(doc.kind);
    requirePermission(ctx, side === "sales" ? "sales.issue" : "purchases.manage");
    if (doc.status !== "draft") {
      // A retry of an issue that already happened is answered with the document.
      if (opts.idempotencyKey && doc.journalEntryId) return doc;
      throw new ConflictError(`${KIND_LABELS[doc.kind]} ${doc.number ?? ""} is already ${doc.status}.`, "not_draft");
    }
    if (doc.isOpeningBalance) requirePermission(ctx, "opening_balances.manage");
    const lines = await tx
      .select()
      .from(documentLines)
      .where(and(eq(documentLines.orgId, ctx.orgId), eq(documentLines.documentId, id)))
      .orderBy(asc(documentLines.lineNo));
    const input = inputFromDocument(doc, lines);
    input.fxRate = doc.currency === ctx.org.baseCurrency ? null : doc.fxRate;
    const r = await resolveDocument(tx, ctx, input, { forPosting: POSTING_KINDS.includes(doc.kind) });
    const number = doc.number ?? (await nextNumber(tx, ctx.orgId, doc.kind)).formatted;
    const [org] = await tx.select().from(organizations).where(eq(organizations.id, ctx.orgId));

    if (!POSTING_KINDS.includes(doc.kind)) {
      const [row] = await tx
        .update(documents)
        .set({
          ...headerValues(ctx, input, r),
          status: doc.kind === "estimate" ? "sent" : "issued",
          number: doc.number ?? number,
          issuedAt: new Date(),
          issuedBy: ctx.actor.userId,
          brandingSnapshot: org?.profile ?? null,
          updatedAt: new Date(),
        })
        .where(eq(documents.id, id))
        .returning();
      await writeLines(tx, ctx, id, r);
      await audit(tx, ctx, { action: "document.issued", entityType: "document", entityId: id, metadata: { kind: doc.kind, number: row!.number } });
      return row!;
    }

    const docLines = await writeLines(tx, ctx, id, r);
    const base = ctx.org.baseCurrency;
    const baseMu = minorUnits(base);
    const rate = r.rate.rate;
    const toBase = (v: Decimal) => v.mul(rate).round(baseMu, "half_up");
    const s = lineSign(doc.kind);
    const ledgerLines: LineInput[] = [];
    let baseSum = Decimal.ZERO;
    const fxFields = r.currency === base ? {} : { fxRate: rate.toString(), exchangeRateId: r.rate.exchangeRateId };
    // Bill lines drawn from purchase-order lines: what was already received relieves GRNI (lib/purchases/matching.ts).
    const poPlan: Map<string, PoMatchPlan> = doc.kind === "bill" ? await planPoMatching(tx, ctx, doc, docLines, { allowOverBilling: opts.allowOverBilling ?? false }) : new Map();
    const poVariance = new Map<string, Decimal>();
    const receiveOverride = new Map<string, { qty: Decimal; value: Decimal }>();
    const grniAccount = [...poPlan.values()].some((p) => p.isStock && p.matchedQty.isPositive()) ? await systemAccountId(tx, ctx.orgId, "goods_received_not_invoiced") : null;
    const ppvAccount = grniAccount ? await systemAccountId(tx, ctx.orgId, "purchase_price_variance") : null;

    docLines.forEach((dl, i) => {
      const c = r.computed.lines[i]!;
      // Purchase tax that is not recoverable is part of the line's cost.
      const nonRecoverable = side === "purchases" ? Decimal.sum(c.taxes.filter((t) => !t.component.isRecoverable).map((t) => t.amount)) : Decimal.ZERO;
      let lineTxn = c.net.add(nonRecoverable);
      let lineBase = toBase(lineTxn);
      baseSum = baseSum.add(lineBase);
      const plan = poPlan.get(dl.id);
      if (plan && plan.isStock && plan.matchedQty.isPositive() && grniAccount && ppvAccount) {
        // The matched part: relieve GRNI at the received value; the difference is price variance.
        const qty = Decimal.from(dl.quantity);
        const matchedBase = plan.matchedQty.eq(qty) ? lineBase : lineBase.mulDiv(plan.matchedQty, qty, baseMu, "half_up");
        const matchedTxn = plan.matchedQty.eq(qty) ? lineTxn : lineTxn.mulDiv(plan.matchedQty, qty, minorUnits(r.currency), "half_up");
        const variance = matchedBase.sub(plan.grniValue);
        poVariance.set(dl.id, variance);
        const common = { contactId: doc.contactId, itemId: dl.itemId, sourceLineId: dl.id, projectId: dl.projectId, classId: dl.classId, departmentId: dl.departmentId, locationId: dl.locationId, fundId: dl.fundId };
        ledgerLines.push({ accountId: grniAccount, amount: plan.grniValue.toString(), currency: base, description: `Goods received, now billed: ${dl.description}`.slice(0, 300), quantity: plan.matchedQty.toString(), ...common });
        if (!variance.isZero()) {
          ledgerLines.push({ accountId: ppvAccount, amount: variance.toString(), currency: base, description: `Price variance: ${dl.description}`.slice(0, 300), ...common });
        }
        lineTxn = lineTxn.sub(matchedTxn);
        lineBase = lineBase.sub(matchedBase);
        receiveOverride.set(dl.id, { qty: plan.receivedWithBill, value: lineBase });
        if (lineTxn.isZero() && lineBase.isZero()) return;
      }
      ledgerLines.push({
        accountId: dl.accountId!,
        amount: lineTxn.mul(-s).toString(),
        currency: r.currency,
        ...fxFields,
        baseAmount: lineBase.mul(-s).toString(),
        description: dl.description || null,
        contactId: doc.contactId,
        itemId: dl.itemId,
        quantity: dl.quantity,
        projectId: dl.projectId,
        classId: dl.classId,
        departmentId: dl.departmentId,
        locationId: dl.locationId,
        fundId: dl.fundId,
        trustComponent: dl.trustComponent,
        beneficiaryId: dl.beneficiaryId,
        sourceLineId: dl.id,
        billableStatus: side === "purchases" && dl.billableCustomerId ? "billable" : null,
      });
    });
    // Tax lines, one per account and rate.
    const taxAgg = new Map<string, { accountId: string; taxRateId: string; txn: Decimal; base: Decimal; name: string }>();
    r.computed.lines.forEach((c) => {
      for (const t of c.taxes) {
        if (t.amount.isZero()) continue;
        if (side === "purchases" && !t.component.isRecoverable) continue;
        const accountId = t.component.accountId!;
        const key = `${accountId}|${t.component.taxRateId}`;
        const a = taxAgg.get(key) ?? { accountId, taxRateId: t.component.taxRateId, txn: Decimal.ZERO, base: Decimal.ZERO, name: t.component.jurisdictionName ?? "Tax" };
        a.txn = a.txn.add(t.amount);
        a.base = a.base.add(toBase(t.amount));
        taxAgg.set(key, a);
      }
    });
    for (const a of taxAgg.values()) {
      baseSum = baseSum.add(a.base);
      ledgerLines.push({
        accountId: a.accountId,
        amount: a.txn.mul(-s).toString(),
        currency: r.currency,
        ...fxFields,
        baseAmount: a.base.mul(-s).toString(),
        description: `${a.name} tax`,
        contactId: doc.contactId,
        taxRateId: a.taxRateId,
      });
    }
    // The receivable/payable (or the cash account) for the total.
    const totalTxn = r.computed.total;
    const controlKey = CONTROL_KEY[doc.kind];
    const counterAccount = controlKey ? await systemAccountId(tx, ctx.orgId, controlKey) : doc.cashAccountId!;
    ledgerLines.push({
      accountId: counterAccount,
      amount: totalTxn.mul(s).toString(),
      currency: r.currency,
      ...fxFields,
      baseAmount: baseSum.mul(s).toString(),
      description: `${KIND_LABELS[doc.kind]} ${number ?? doc.reference ?? ""}`.trim(),
      contactId: doc.contactId,
      openItem: controlKey ? { type: "document", id } : null,
    });

    const postingDate = r.postingDate;
    const posted = await postEntry(tx, ctx, {
      kind: doc.kind as EntryKind,
      entryDate: postingDate,
      documentDate: doc.issueDate,
      description: `${KIND_LABELS[doc.kind]} ${number ?? doc.reference ?? ""} — ${r.contact.displayName}`.trim(),
      sourceType: "document",
      sourceId: id,
      sourceRef: number ?? doc.reference,
      idempotencyKey: opts.idempotencyKey ? `issue:${opts.idempotencyKey}` : `document:${id}:issue`,
      cashBasis: controlKey ? "deferred" : "as_is",
      allowControlAccounts: true,
      lines: ledgerLines,
    });

    await postInventoryForDocument(tx, ctx, doc, docLines, r, posted.entry.id, postingDate, receiveOverride);
    await recordPoMatches(tx, ctx, id, poPlan, poVariance);

    const status = doc.kind === "sales_receipt" || doc.kind === "expense" ? "paid" : totalTxn.isZero() ? (doc.kind === "invoice" || doc.kind === "bill" ? "paid" : "closed") : "issued";
    const [row] = await tx
      .update(documents)
      .set({
        ...headerValues(ctx, input, r),
        baseTotal: baseSum.toString(),
        status,
        number: number ?? doc.number,
        journalEntryId: posted.entry.id,
        issuedAt: new Date(),
        issuedBy: ctx.actor.userId,
        brandingSnapshot: org?.profile ?? null,
        updatedAt: new Date(),
      })
      .where(eq(documents.id, id))
      .returning();
    await audit(tx, ctx, {
      action: "document.issued",
      entityType: "document",
      entityId: id,
      metadata: { kind: doc.kind, number: row!.number, total: totalTxn.toString(), currency: r.currency, entryId: posted.entry.id },
    });
    return row!;
  });
}

/** Stock movements and the cost-of-goods entry for a posted document. */
async function postInventoryForDocument(
  tx: Tx,
  ctx: Ctx,
  doc: Document,
  docLines: DocumentLine[],
  r: Resolved,
  docEntryId: string,
  date: string,
  /** Bill lines matched to purchase-order receipts: only the quantity received with the bill comes in, at this value. */
  receiveOverride: Map<string, { qty: Decimal; value: Decimal }> = new Map(),
) {
  const stockLines = docLines
    .map((dl, i) => ({ dl, res: r.lines[i]!, comp: r.computed.lines[i]! }))
    .filter((x) => x.res.item?.kind === "stock" && !Decimal.from(x.dl.quantity).isZero());
  if (!stockLines.length) return;
  const fallbackLocation = doc.inventoryLocationId ?? (await defaultLocationId(tx, ctx));
  const baseMu = minorUnits(ctx.org.baseCurrency);
  const cogsLines: LineInput[] = [];
  const moveIds: string[] = [];
  for (const { dl, res, comp } of stockLines) {
    const item = res.item!;
    const locationId = dl.inventoryLocationId ?? fallbackLocation;
    const qty = Decimal.from(dl.quantity);
    const source = { sourceType: "document", sourceId: doc.id, sourceLineId: dl.id };
    if (doc.kind === "invoice" || doc.kind === "sales_receipt") {
      const move = await issueStock(tx, ctx, { itemId: item.id, locationId, date, quantity: qty.toString(), kind: "sale", source });
      moveIds.push(move.id);
      const cost = Decimal.from(move.value).neg();
      if (!cost.isZero()) {
        const dims = { projectId: dl.projectId, classId: dl.classId, departmentId: dl.departmentId, locationId: dl.locationId, fundId: dl.fundId };
        cogsLines.push({ accountId: item.expenseAccountId!, amount: cost.toString(), description: `Cost of ${item.name}`, itemId: item.id, quantity: qty.toString(), sourceLineId: dl.id, contactId: doc.contactId, ...dims });
        cogsLines.push({ accountId: item.inventoryAccountId!, amount: cost.neg().toString(), description: `${item.name} sold`, itemId: item.id, quantity: qty.neg().toString(), sourceLineId: dl.id, ...dims });
      }
    } else if (doc.kind === "credit_note") {
      // A return: back into stock at the cost it left at (the original sale), else at today's average.
      let value: Decimal | null = null;
      if (dl.returnOfLineId) {
        const orig = await tx
          .select()
          .from(stockMoves)
          .where(and(eq(stockMoves.orgId, ctx.orgId), eq(stockMoves.sourceLineId, dl.returnOfLineId), eq(stockMoves.kind, "sale")));
        const oq = Decimal.sum(orig.map((m) => m.quantity)).abs();
        const ov = Decimal.sum(orig.map((m) => m.value)).abs();
        if (!oq.isZero()) value = ov.mulDiv(qty, oq, baseMu, "half_up");
      }
      if (value === null) {
        const [c] = await tx.select().from(itemCosts).where(and(eq(itemCosts.orgId, ctx.orgId), eq(itemCosts.itemId, item.id)));
        const q = Decimal.from(c?.qtyOnHand ?? "0");
        if (q.isZero()) {
          throw new ValidationError(`${item.name} has no stock to take an average cost from. Link the credit-note line to the invoice line it returns, so it comes back at its original cost.`, {
            [`lines.${dl.lineNo - 1}.returnOfLineId`]: "Link to the original invoice line.",
          });
        }
        value = Decimal.from(c!.totalValue).mulDiv(qty, q, baseMu, "half_up");
      }
      const move = await receiveStock(tx, ctx, { itemId: item.id, locationId, date, quantity: qty.toString(), value: value.toString(), kind: "sale_return", source });
      moveIds.push(move.id);
      if (!value.isZero()) {
        cogsLines.push({ accountId: item.inventoryAccountId!, amount: value.toString(), description: `${item.name} returned`, itemId: item.id, quantity: qty.toString(), sourceLineId: dl.id });
        cogsLines.push({ accountId: item.expenseAccountId!, amount: value.neg().toString(), description: `Cost of ${item.name} returned`, itemId: item.id, sourceLineId: dl.id, contactId: doc.contactId });
      }
    } else if (doc.kind === "bill" || doc.kind === "expense") {
      // Received at what the document debited to inventory for the line.
      const nonRecoverable = Decimal.sum(comp.taxes.filter((t) => !t.component.isRecoverable).map((t) => t.amount));
      const override = receiveOverride.get(dl.id);
      const receiveQty = override ? override.qty : qty;
      const value = override ? override.value : comp.net.add(nonRecoverable).mul(r.rate.rate).round(baseMu, "half_up");
      if (!receiveQty.isPositive()) continue;
      const move = await receiveStock(tx, ctx, { itemId: item.id, locationId, date, quantity: receiveQty.toString(), value: value.toString(), kind: "receipt", source: { ...source, journalEntryId: docEntryId } });
      moveIds.push(move.id);
    } else if (doc.kind === "vendor_credit") {
      const nonRecoverable = Decimal.sum(comp.taxes.filter((t) => !t.component.isRecoverable).map((t) => t.amount));
      const value = comp.net.add(nonRecoverable).mul(r.rate.rate).round(baseMu, "half_up");
      const move = await issueStock(tx, ctx, { itemId: item.id, locationId, date, quantity: qty.toString(), kind: "purchase_return", source: { ...source, journalEntryId: docEntryId }, valueOverride: value.toString() });
      moveIds.push(move.id);
    }
  }
  if (cogsLines.length) {
    const posted = await postEntry(tx, ctx, {
      kind: "inventory",
      entryDate: date,
      documentDate: doc.issueDate,
      description: `${doc.kind === "credit_note" ? "Stock returned" : "Cost of goods sold"} — ${KIND_LABELS[doc.kind]} ${doc.number ?? ""}`.trim(),
      sourceType: "document",
      sourceId: doc.id,
      sourceRef: doc.number,
      cashBasis: "as_is",
      allowControlAccounts: true,
      lines: cogsLines,
    });
    if (moveIds.length) {
      await tx
        .update(stockMoves)
        .set({ journalEntryId: posted.entry.id })
        .where(and(eq(stockMoves.orgId, ctx.orgId), inArray(stockMoves.id, moveIds), sql`${stockMoves.journalEntryId} is null`));
    }
  }
}

/**
 * Void an issued document: reverse its entries and stock on `date`. Refused
 * while payments or credits are applied to it — remove those first, or
 * correct it with a credit note.
 */
export async function voidDocument(ctx: Ctx, id: string, opts: { date?: string | null; reason: string }): Promise<Document> {
  if (!opts.reason?.trim()) throw new ValidationError("Say why the document is being voided.", { reason: "Required." });
  return withTransaction(async (tx) => {
    const [doc] = await tx
      .select()
      .from(documents)
      .where(and(eq(documents.orgId, ctx.orgId), eq(documents.id, id)))
      .for("update");
    if (!doc) throw new NotFoundError("The document");
    requirePermission(ctx, SIDE(doc.kind) === "sales" ? "sales.void" : "purchases.void");
    if (doc.status === "void") throw new ConflictError("This document is already void.", "already_void");
    if (doc.status === "draft") throw new ConflictError("Delete a draft instead of voiding it.", "is_draft");
    if (!POSTING_KINDS.includes(doc.kind)) {
      const status = doc.kind === "purchase_order" ? "cancelled" : "declined";
      const [row] = await tx.update(documents).set({ status, voidReason: opts.reason, voidedAt: new Date(), voidedBy: ctx.actor.userId, updatedAt: new Date() }).where(eq(documents.id, id)).returning();
      await audit(tx, ctx, { action: "document.cancelled", entityType: "document", entityId: id, reason: opts.reason });
      return row!;
    }
    const [applied] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(settlements)
      .where(and(eq(settlements.orgId, ctx.orgId), eq(settlements.status, "active"), or(eq(settlements.debitItemId, id), eq(settlements.creditItemId, id))));
    if ((applied?.n ?? 0) > 0) {
      throw new ConflictError(
        "Payments or credits are applied to this document. Remove them first, or issue a credit note to correct it instead of voiding.",
        "has_settlements",
      );
    }
    const date = opts.date || todayIn(ctx.org.timezone);
    assertIsoDate(date, "void date");
    const docDate = doc.postingDate ?? doc.issueDate;
    const voidDate = date < docDate ? docDate : date;
    const rev = await reverseEntryInternal(tx, ctx, doc.journalEntryId!, { date: voidDate, reason: `Void: ${opts.reason.trim()}` });
    // Stock: undo each move this document made, newest first, then the cost entries.
    const moves = await tx
      .select()
      .from(stockMoves)
      .where(and(eq(stockMoves.orgId, ctx.orgId), eq(stockMoves.sourceType, "document"), eq(stockMoves.sourceId, id), sql`${stockMoves.reversesMoveId} is null`))
      .orderBy(desc(stockMoves.seq));
    for (const m of moves) await reverseMove(tx, ctx, m, voidDate, { sourceType: "document_void", sourceId: id, reason: opts.reason });
    const invEntries = await tx
      .select()
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.orgId, ctx.orgId),
          eq(journalEntries.sourceType, "document"),
          eq(journalEntries.sourceId, id),
          eq(journalEntries.kind, "inventory"),
          sql`${journalEntries.reversesEntryId} is null`,
        ),
      );
    for (const e of invEntries) await reverseEntryInternal(tx, ctx, e.id, { date: voidDate, reason: `Void: ${opts.reason.trim()}` });
    if (doc.kind === "bill") await unwindPoMatches(tx, ctx, id);
    const [row] = await tx
      .update(documents)
      .set({ status: "void", voidedAt: new Date(), voidedBy: ctx.actor.userId, voidReason: opts.reason.trim(), voidEntryId: rev.entry.id, updatedAt: new Date() })
      .where(eq(documents.id, id))
      .returning();
    await audit(tx, ctx, { action: "document.voided", entityType: "document", entityId: id, reason: opts.reason.trim(), metadata: { kind: doc.kind, number: doc.number, voidDate } });
    return row!;
  });
}

/** Turn an estimate into a draft invoice (the estimate is marked converted). */
export async function convertEstimate(ctx: Ctx, estimateId: string): Promise<Document> {
  requirePermission(ctx, "sales.manage");
  const { doc, lines } = await getDocument(getDb(), ctx.orgId, estimateId);
  if (doc.kind !== "estimate") throw new ConflictError("Only an estimate converts to an invoice.", "not_estimate");
  if (!["draft", "sent", "accepted"].includes(doc.status)) throw new ConflictError(`This estimate is ${doc.status}.`, "not_convertible");
  const input = inputFromDocument(doc, lines);
  const today = todayIn(ctx.org.timezone);
  const invoice = await saveDraft(ctx, {
    ...input,
    kind: "invoice",
    issueDate: today,
    postingDate: null,
    dueDate: null,
    expiryDate: null,
    sourceDocumentId: doc.id,
    lines: input.lines.map((l, i) => ({ ...l, sourceLineId: lines[i]!.id })),
  });
  await withTransaction(async (tx) => {
    await tx.update(documents).set({ status: "converted", updatedAt: new Date() }).where(and(eq(documents.orgId, ctx.orgId), eq(documents.id, estimateId)));
    await audit(tx, ctx, { action: "estimate.converted", entityType: "document", entityId: estimateId, metadata: { invoiceId: invoice.id } });
  });
  return invoice;
}

/** Change an estimate's status (accepted, declined, expired). */
export async function setEstimateStatus(ctx: Ctx, id: string, status: "sent" | "accepted" | "declined" | "expired") {
  requirePermission(ctx, "sales.manage");
  return withTransaction(async (tx) => {
    const [d] = await tx.select().from(documents).where(and(eq(documents.orgId, ctx.orgId), eq(documents.id, id))).for("update");
    if (!d || d.kind !== "estimate") throw new NotFoundError("The estimate");
    if (!canTransition("estimate", d.status, status)) throw new ConflictError(`An estimate that is ${d.status} cannot become ${status}.`, "invalid_transition");
    const [row] = await tx.update(documents).set({ status, updatedAt: new Date() }).where(eq(documents.id, id)).returning();
    await audit(tx, ctx, { action: `estimate.${status}`, entityType: "document", entityId: id });
    return row!;
  });
}

/**
 * Write off what is left on an invoice as bad debt: a write-off document for
 * the amount, settled against the invoice.
 */
export async function writeOffInvoice(ctx: Ctx, invoiceId: string, opts: { amount?: string | null; date: string; reason: string; accountId?: string | null }) {
  requirePermission(ctx, "sales.void");
  if (!opts.reason?.trim()) throw new ValidationError("Say why the balance is being written off.", { reason: "Required." });
  assertIsoDate(opts.date, "write-off date");
  return withTransaction(async (tx) => {
    const [inv] = await tx.select().from(documents).where(and(eq(documents.orgId, ctx.orgId), eq(documents.id, invoiceId))).for("update");
    if (!inv || inv.kind !== "invoice") throw new NotFoundError("The invoice");
    const bal = await itemBalance(tx, ctx.orgId, invoiceId);
    const amount = opts.amount ? Decimal.from(opts.amount.replace(/,/g, "")) : bal.txn;
    if (!amount.isPositive() || amount.gt(bal.txn)) throw new ValidationError(`Write off between 0 and ${bal.txn.toString()}.`, { amount: "Out of range." });
    const accountId = opts.accountId || (await systemAccountId(tx, ctx.orgId, "bad_debt"));
    const rate = inv.currency === ctx.org.baseCurrency ? null : (await resolveRate(tx, ctx, inv.currency, opts.date)).rate;
    const number = (await nextNumber(tx, ctx.orgId, "write_off")).formatted;
    const baseAmt = rate ? amount.mul(rate).round(minorUnits(ctx.org.baseCurrency), "half_up") : amount;
    const [wo] = await tx
      .insert(documents)
      .values({
        orgId: ctx.orgId,
        kind: "write_off",
        side: "sales",
        number,
        status: "draft",
        contactId: inv.contactId,
        issueDate: opts.date,
        currency: inv.currency,
        fxRate: (rate ?? Decimal.ONE).toString(),
        subtotal: amount.toString(),
        total: amount.toString(),
        baseTotal: baseAmt.toString(),
        memo: opts.reason.trim(),
        sourceDocumentId: inv.id,
        issuedAt: new Date(),
        issuedBy: ctx.actor.userId,
        createdBy: ctx.actor.userId,
      })
      .returning();
    const [line] = await tx
      .insert(documentLines)
      .values({ orgId: ctx.orgId, documentId: wo!.id, lineNo: 1, description: `Bad debt — ${inv.number}`, quantity: "1", unitPrice: amount.toString(), accountId, netAmount: amount.toString(), grossAmount: amount.toString() })
      .returning();
    const ar = await systemAccountId(tx, ctx.orgId, "accounts_receivable");
    const fx = rate ? { fxRate: rate.toString() } : {};
    const posted = await postEntry(tx, ctx, {
      kind: "write_off",
      entryDate: opts.date,
      description: `Write-off ${number} of ${inv.number}`,
      sourceType: "document",
      sourceId: wo!.id,
      sourceRef: number,
      cashBasis: "deferred",
      allowControlAccounts: true,
      lines: [
        { accountId, amount: amount.toString(), currency: inv.currency, ...fx, baseAmount: baseAmt.toString(), contactId: inv.contactId, sourceLineId: line!.id, description: opts.reason.trim() },
        { accountId: ar, amount: amount.neg().toString(), currency: inv.currency, ...fx, baseAmount: baseAmt.neg().toString(), contactId: inv.contactId, openItem: { type: "document", id: wo!.id } },
      ],
    });
    await tx.update(documents).set({ journalEntryId: posted.entry.id, status: "issued" }).where(eq(documents.id, wo!.id));
    await settle(tx, ctx, { debit: { type: "document", id: invoiceId }, credit: { type: "document", id: wo!.id }, amount: amount.toString(), date: opts.date });
    await audit(tx, ctx, { action: "invoice.written_off", entityType: "document", entityId: invoiceId, reason: opts.reason.trim(), metadata: { amount: amount.toString(), writeOffId: wo!.id } });
    return wo!;
  });
}

export async function getDocument(db: DbOrTx, orgId: string, id: string) {
  const [doc] = await db.select().from(documents).where(and(eq(documents.orgId, orgId), eq(documents.id, id))).limit(1);
  if (!doc) throw new NotFoundError("The document");
  const lines = await db.select().from(documentLines).where(and(eq(documentLines.orgId, orgId), eq(documentLines.documentId, id))).orderBy(asc(documentLines.lineNo));
  const taxes = await db.select().from(documentLineTaxes).where(and(eq(documentLineTaxes.orgId, orgId), eq(documentLineTaxes.documentId, id)));
  return { doc, lines, taxes };
}

export interface DocumentFilters {
  kind?: DocumentKind | DocumentKind[];
  side?: "sales" | "purchases";
  status?: string;
  contactId?: string;
  from?: string;
  to?: string;
  q?: string;
  overdue?: boolean;
  today?: string;
  page?: number;
  pageSize?: number;
  sort?: "date_desc" | "date_asc" | "number_desc" | "number_asc" | "total_desc" | "total_asc" | "due_asc";
}

export async function listDocuments(db: DbOrTx, orgId: string, f: DocumentFilters = {}) {
  const conds: SQL[] = [eq(documents.orgId, orgId)];
  if (f.kind) conds.push(Array.isArray(f.kind) ? inArray(documents.kind, f.kind) : eq(documents.kind, f.kind));
  if (f.side) conds.push(eq(documents.side, f.side));
  if (f.status === "open") conds.push(inArray(documents.status, ["issued", "partially_paid"]));
  else if (f.status) conds.push(eq(documents.status, f.status as never));
  if (f.contactId) conds.push(eq(documents.contactId, f.contactId));
  if (f.from) conds.push(gte(documents.issueDate, f.from));
  if (f.to) conds.push(lte(documents.issueDate, f.to));
  if (f.overdue) {
    conds.push(inArray(documents.status, ["issued", "partially_paid"]));
    conds.push(sql`${documents.dueDate} < ${f.today ?? todayIn()}`);
  }
  if (f.q) {
    const like = `%${f.q.replace(/[%_]/g, "\\$&")}%`;
    conds.push(
      or(
        ilike(documents.number, like),
        ilike(documents.reference, like),
        ilike(documents.memo, like),
        sql`exists (select 1 from contacts c where c.org_id = ${documents.orgId} and c.id = ${documents.contactId} and c.display_name ilike ${like})`,
      )!,
    );
  }
  const pageSize = Math.min(Math.max(f.pageSize ?? 50, 1), 500);
  const page = Math.max(f.page ?? 1, 1);
  const order =
    f.sort === "date_asc"
      ? [asc(documents.issueDate), asc(documents.number)]
      : f.sort === "number_desc"
        ? [desc(documents.number)]
        : f.sort === "number_asc"
          ? [asc(documents.number)]
          : f.sort === "total_desc"
            ? [desc(documents.total)]
            : f.sort === "total_asc"
              ? [asc(documents.total)]
              : f.sort === "due_asc"
                ? [asc(documents.dueDate)]
                : [desc(documents.issueDate), desc(documents.createdAt)];
  const where = and(...conds);
  const [rows, [count]] = await Promise.all([
    db
      .select({
        doc: documents,
        contactName: contacts.displayName,
        openAmount: sql<string>`(select coalesce(sum(l.txn_amount), 0)::text from journal_lines l join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id where l.org_id = ${documents.orgId} and l.open_item_id = ${documents.id} and e.status = 'posted')`,
      })
      .from(documents)
      .leftJoin(contacts, and(eq(contacts.orgId, documents.orgId), eq(contacts.id, documents.contactId)))
      .where(where)
      .orderBy(...order)
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(documents).where(where),
  ]);
  return {
    rows: rows.map((r) => {
      const nature = ["invoice", "vendor_credit"].includes(r.doc.kind) ? 1 : -1;
      return { ...r, openAmount: Decimal.from(r.openAmount).mul(nature).toString() };
    }),
    total: count?.n ?? 0,
    page,
    pageSize,
  };
}
