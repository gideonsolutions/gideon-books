/**
 * Receivables and payables: sales and purchase documents, their lines and
 * the tax computed on each, payments, settlements between open items, the
 * cash-basis projection of settlements, and recurring templates.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, currencyCode, day, fxRate, id, money, orgId, quantity, rate, ts, unitAmount, updatedAt } from "./_columns";
import { organizations, type OrgProfile } from "./core";
import {
  accounts,
  contacts,
  dimensionValues,
  exchangeRates,
  inventoryLocations,
  items,
  journalEntries,
  journalLines,
  paymentTerms,
  projects,
  taxCodes,
  taxJurisdictions,
  taxRates,
  type Address,
} from "./ledger";

export const DOCUMENT_KINDS = [
  "estimate",
  "invoice",
  "credit_note",
  "write_off",
  "sales_receipt",
  "purchase_order",
  "bill",
  "vendor_credit",
  "expense",
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/**
 * Status values across kinds. Valid transitions per kind live in
 * lib/commerce/states.ts; overdue is derived from the due date, not stored.
 */
export const DOCUMENT_STATUSES = [
  "draft",
  "sent",
  "accepted",
  "declined",
  "converted",
  "expired",
  "issued",
  "partially_paid",
  "paid",
  "partially_received",
  "received",
  "closed",
  "cancelled",
  "void",
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const documents = pgTable(
  "documents",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id),
    kind: text("kind", { enum: DOCUMENT_KINDS }).notNull(),
    side: text("side", { enum: ["sales", "purchases"] }).notNull(),
    /** Assigned on issue from the kind's sequence (configurable prefix). Vendor documents carry the vendor's number in `reference`. */
    number: text("number"),
    status: text("status", { enum: DOCUMENT_STATUSES }).notNull().default("draft"),
    contactId: uuid("contact_id"),
    /** Document date: the date printed on it. */
    issueDate: day("issue_date").notNull(),
    /** Posting date: the date it affects the ledger (defaults to the document date). */
    postingDate: day("posting_date"),
    dueDate: day("due_date"),
    /** Estimates: valid until. Purchase orders: expected delivery. */
    expiryDate: day("expiry_date"),
    paymentTermsId: uuid("payment_terms_id"),
    currency: currencyCode("currency").notNull(),
    fxRate: fxRate("fx_rate").notNull().default("1"),
    exchangeRateId: uuid("exchange_rate_id"),
    /** Prices include tax; tax is backed out of each line. */
    taxInclusive: boolean("tax_inclusive").notNull().default(false),
    /** Document-level discount, spread over taxable lines before tax. */
    discountType: text("discount_type", { enum: ["percent", "amount"] }),
    discountValue: unitAmount("discount_value"),
    subtotal: money("subtotal").notNull().default("0"),
    discountTotal: money("discount_total").notNull().default("0"),
    taxTotal: money("tax_total").notNull().default("0"),
    total: money("total").notNull().default("0"),
    baseTotal: money("base_total").notNull().default("0"),
    /** Customer's PO number, or the vendor's own invoice number. */
    reference: text("reference"),
    /** Internal note. */
    memo: text("memo"),
    /** Printed on the document. */
    notes: text("notes"),
    billingAddress: jsonb("billing_address").$type<Address>(),
    shippingAddress: jsonb("shipping_address").$type<Address>(),
    /** Sales receipts: where the money went. Expenses: what paid for it. */
    cashAccountId: uuid("cash_account_id"),
    /** Purchases: the default stock location for received items. */
    inventoryLocationId: uuid("inventory_location_id"),
    journalEntryId: uuid("journal_entry_id"),
    /** Estimate → invoice, purchase order → bill, invoice → credit note (the document this one came from or corrects). */
    sourceDocumentId: uuid("source_document_id"),
    recurringTemplateId: uuid("recurring_template_id"),
    /** A document entered to carry an opening balance; it posts to opening balance equity. */
    isOpeningBalance: boolean("is_opening_balance").notNull().default(false),
    /** Purchases: an employee's out-of-pocket expense claim, reimbursed as a payable. */
    isReimbursement: boolean("is_reimbursement").notNull().default(false),
    issuedAt: ts("issued_at"),
    issuedBy: uuid("issued_by"),
    sentAt: ts("sent_at"),
    voidedAt: ts("voided_at"),
    voidedBy: uuid("voided_by"),
    voidReason: text("void_reason"),
    voidEntryId: uuid("void_entry_id"),
    /** Snapshot of the organization's branding when issued, so a reprint matches what was sent. */
    brandingSnapshot: jsonb("branding_snapshot").$type<OrgProfile>(),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("documents_org_id_uq").on(t.orgId, t.id),
    uniqueIndex("documents_org_kind_number_uq").on(t.orgId, t.kind, t.number).where(sql`${t.number} is not null and ${t.side} = 'sales'`),
    index("documents_org_kind_status_idx").on(t.orgId, t.kind, t.status),
    index("documents_org_contact_idx").on(t.orgId, t.contactId),
    index("documents_org_date_idx").on(t.orgId, t.issueDate),
    foreignKey({ columns: [t.orgId, t.contactId], foreignColumns: [contacts.orgId, contacts.id] }),
    foreignKey({ columns: [t.orgId, t.paymentTermsId], foreignColumns: [paymentTerms.orgId, paymentTerms.id] }),
    foreignKey({ columns: [t.orgId, t.exchangeRateId], foreignColumns: [exchangeRates.orgId, exchangeRates.id] }),
    foreignKey({ columns: [t.orgId, t.cashAccountId], foreignColumns: [accounts.orgId, accounts.id] }),
    foreignKey({ columns: [t.orgId, t.inventoryLocationId], foreignColumns: [inventoryLocations.orgId, inventoryLocations.id] }),
    foreignKey({ columns: [t.orgId, t.journalEntryId], foreignColumns: [journalEntries.orgId, journalEntries.id] }),
    foreignKey({ columns: [t.orgId, t.voidEntryId], foreignColumns: [journalEntries.orgId, journalEntries.id] }),
    foreignKey({ columns: [t.orgId, t.sourceDocumentId], foreignColumns: [t.orgId, t.id] }),
    check(
      "documents_side_matches_kind",
      sql`(${t.side} = 'sales') = (${t.kind} in ('estimate','invoice','credit_note','write_off','sales_receipt'))`,
    ),
    check("documents_fx_positive", sql`${t.fxRate} > 0`),
  ],
);

export const documentLines = pgTable(
  "document_lines",
  {
    id: id(),
    orgId: orgId(),
    documentId: uuid("document_id").notNull(),
    lineNo: integer("line_no").notNull(),
    lineType: text("line_type", { enum: ["item", "shipping"] }).notNull().default("item"),
    itemId: uuid("item_id"),
    description: text("description").notNull().default(""),
    quantity: quantity("quantity").notNull().default("1"),
    unitPrice: unitAmount("unit_price").notNull().default("0"),
    /** Line discount as a fraction (0.1 = 10%). */
    discountRate: rate("discount_rate"),
    /** Share of the document-level discount spread onto this line. */
    documentDiscount: money("document_discount").notNull().default("0"),
    /** Ledger account for the line (income, expense, asset, inventory). */
    accountId: uuid("account_id"),
    taxCodeId: uuid("tax_code_id"),
    /** Net amount after discounts and excluding tax. */
    netAmount: money("net_amount").notNull().default("0"),
    taxAmount: money("tax_amount").notNull().default("0"),
    /** Tax-inclusive documents: what the customer sees on the line. */
    grossAmount: money("gross_amount").notNull().default("0"),
    serviceDate: day("service_date"),
    projectId: uuid("project_id"),
    classId: uuid("class_id"),
    departmentId: uuid("department_id"),
    locationId: uuid("location_id"),
    fundId: uuid("fund_id"),
    trustComponent: text("trust_component", { enum: ["principal", "income"] }),
    beneficiaryId: uuid("beneficiary_id"),
    inventoryLocationId: uuid("inventory_location_id"),
    /** Purchases: re-bill this cost to a customer (time & materials). */
    billableCustomerId: uuid("billable_customer_id"),
    billedOnLineId: uuid("billed_on_line_id"),
    /** Purchase orders: quantities received and billed so far. */
    receivedQuantity: quantity("received_quantity").notNull().default("0"),
    billedQuantity: quantity("billed_quantity").notNull().default("0"),
    /** The estimate/PO line this was converted from. */
    sourceLineId: uuid("source_line_id"),
    /** Credit notes / vendor credits returning stock: the original invoice/bill line, for its cost. */
    returnOfLineId: uuid("return_of_line_id"),
  },
  (t) => [
    unique("document_lines_org_id_uq").on(t.orgId, t.id),
    unique("document_lines_doc_line_uq").on(t.documentId, t.lineNo),
    index("document_lines_doc_idx").on(t.documentId),
    foreignKey({ columns: [t.orgId, t.documentId], foreignColumns: [documents.orgId, documents.id] }).onDelete("cascade"),
    foreignKey({ columns: [t.orgId, t.itemId], foreignColumns: [items.orgId, items.id] }),
    foreignKey({ columns: [t.orgId, t.accountId], foreignColumns: [accounts.orgId, accounts.id] }),
    foreignKey({ columns: [t.orgId, t.taxCodeId], foreignColumns: [taxCodes.orgId, taxCodes.id] }),
    foreignKey({ columns: [t.orgId, t.projectId], foreignColumns: [projects.orgId, projects.id] }),
    foreignKey({ columns: [t.orgId, t.classId], foreignColumns: [dimensionValues.orgId, dimensionValues.id] }),
    foreignKey({ columns: [t.orgId, t.departmentId], foreignColumns: [dimensionValues.orgId, dimensionValues.id] }),
    foreignKey({ columns: [t.orgId, t.locationId], foreignColumns: [dimensionValues.orgId, dimensionValues.id] }),
    foreignKey({ columns: [t.orgId, t.fundId], foreignColumns: [dimensionValues.orgId, dimensionValues.id] }),
    foreignKey({ columns: [t.orgId, t.beneficiaryId], foreignColumns: [contacts.orgId, contacts.id] }),
    foreignKey({ columns: [t.orgId, t.inventoryLocationId], foreignColumns: [inventoryLocations.orgId, inventoryLocations.id] }),
    foreignKey({ columns: [t.orgId, t.billableCustomerId], foreignColumns: [contacts.orgId, contacts.id] }),
    foreignKey({ columns: [t.orgId, t.sourceLineId], foreignColumns: [t.orgId, t.id] }),
    foreignKey({ columns: [t.orgId, t.returnOfLineId], foreignColumns: [t.orgId, t.id] }),
  ],
);

/** The tax computed on a line, kept with the document: rate, base and amount per jurisdiction. */
export const documentLineTaxes = pgTable(
  "document_line_taxes",
  {
    id: id(),
    orgId: orgId(),
    documentId: uuid("document_id").notNull(),
    documentLineId: uuid("document_line_id").notNull(),
    jurisdictionId: uuid("jurisdiction_id").notNull(),
    taxRateId: uuid("tax_rate_id").notNull(),
    /** The rate as applied (copied, so a later edit of the rate row cannot change it). */
    rate: rate("rate").notNull(),
    sequence: integer("sequence").notNull(),
    isCompound: boolean("is_compound").notNull(),
    taxableAmount: money("taxable_amount").notNull(),
    taxAmount: money("tax_amount").notNull(),
    /** Purchases: recorded as recoverable tax rather than added to cost. */
    isRecoverable: boolean("is_recoverable").notNull().default(false),
    /** The customer or line is exempt: the base is recorded as exempt sales and no tax is charged. */
    isExempt: boolean("is_exempt").notNull().default(false),
    accountId: uuid("account_id"),
  },
  (t) => [
    index("document_line_taxes_doc_idx").on(t.documentId),
    foreignKey({ columns: [t.orgId, t.documentId], foreignColumns: [documents.orgId, documents.id] }).onDelete("cascade"),
    foreignKey({ columns: [t.orgId, t.documentLineId], foreignColumns: [documentLines.orgId, documentLines.id] }).onDelete("cascade"),
    foreignKey({ columns: [t.orgId, t.jurisdictionId], foreignColumns: [taxJurisdictions.orgId, taxJurisdictions.id] }),
    foreignKey({ columns: [t.orgId, t.taxRateId], foreignColumns: [taxRates.orgId, taxRates.id] }),
    foreignKey({ columns: [t.orgId, t.accountId], foreignColumns: [accounts.orgId, accounts.id] }),
  ],
);

export const PAYMENT_KINDS = [
  "customer_payment",
  "customer_deposit",
  "customer_refund",
  "vendor_payment",
  "vendor_prepayment",
  "vendor_refund",
] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

/**
 * Money received or paid. Recording a payment records it; it never moves
 * money. A payment is an open item until settled against documents.
 */
export const payments = pgTable(
  "payments",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id),
    kind: text("kind", { enum: PAYMENT_KINDS }).notNull(),
    number: text("number"),
    contactId: uuid("contact_id").notNull(),
    paymentDate: day("payment_date").notNull(),
    /** Bank, cash, clearing or undeposited-funds account the money moved through. */
    accountId: uuid("account_id").notNull(),
    currency: currencyCode("currency").notNull(),
    /** Amount in `currency`, positive. */
    amount: money("amount").notNull(),
    fxRate: fxRate("fx_rate").notNull().default("1"),
    exchangeRateId: uuid("exchange_rate_id"),
    baseAmount: money("base_amount").notNull(),
    /** Processor fee withheld from a receipt (net deposited = amount − fee). */
    feeAmount: money("fee_amount").notNull().default("0"),
    feeAccountId: uuid("fee_account_id"),
    method: text("method", { enum: ["check", "ach", "wire", "card", "cash", "provider", "other"] }).notNull().default("other"),
    reference: text("reference"),
    memo: text("memo"),
    status: text("status", { enum: ["posted", "void"] }).notNull().default("posted"),
    journalEntryId: uuid("journal_entry_id"),
    voidEntryId: uuid("void_entry_id"),
    voidedAt: ts("voided_at"),
    voidReason: text("void_reason"),
    /** A payment that came from a provider (Stripe charge id, etc.). */
    provider: text("provider"),
    providerRef: text("provider_ref"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("payments_org_id_uq").on(t.orgId, t.id),
    uniqueIndex("payments_provider_ref_uq").on(t.orgId, t.provider, t.providerRef).where(sql`${t.providerRef} is not null`),
    index("payments_org_contact_idx").on(t.orgId, t.contactId),
    index("payments_org_date_idx").on(t.orgId, t.paymentDate),
    foreignKey({ columns: [t.orgId, t.contactId], foreignColumns: [contacts.orgId, contacts.id] }),
    foreignKey({ columns: [t.orgId, t.accountId], foreignColumns: [accounts.orgId, accounts.id] }),
    foreignKey({ columns: [t.orgId, t.feeAccountId], foreignColumns: [accounts.orgId, accounts.id] }),
    foreignKey({ columns: [t.orgId, t.exchangeRateId], foreignColumns: [exchangeRates.orgId, exchangeRates.id] }),
    foreignKey({ columns: [t.orgId, t.journalEntryId], foreignColumns: [journalEntries.orgId, journalEntries.id] }),
    foreignKey({ columns: [t.orgId, t.voidEntryId], foreignColumns: [journalEntries.orgId, journalEntries.id] }),
    check("payments_amount_positive", sql`${t.amount} > 0`),
    check("payments_fee_nonnegative", sql`${t.feeAmount} >= 0 and ${t.feeAmount} < ${t.amount}`),
  ],
);

/**
 * One open item settling another: a payment against an invoice, a credit
 * note against an invoice, a deposit against an invoice, a refund against a
 * credit. The debit item has a debit balance (an invoice; a vendor payment),
 * the credit item a credit balance (a customer payment; a bill). Each
 * settlement posts an entry moving the amount between the two open items,
 * with any exchange difference to realized gain or loss.
 */
export const settlements = pgTable(
  "settlements",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id),
    settlementDate: day("settlement_date").notNull(),
    side: text("side", { enum: ["receivables", "payables"] }).notNull(),
    contactId: uuid("contact_id").notNull(),
    debitItemType: text("debit_item_type", { enum: ["document", "payment"] }).notNull(),
    debitItemId: uuid("debit_item_id").notNull(),
    creditItemType: text("credit_item_type", { enum: ["document", "payment"] }).notNull(),
    creditItemId: uuid("credit_item_id").notNull(),
    currency: currencyCode("currency").notNull(),
    amount: money("amount").notNull(),
    debitBase: money("debit_base").notNull(),
    creditBase: money("credit_base").notNull(),
    /** Realized exchange gain (+) or loss (−) in base currency. */
    fxDifferenceBase: money("fx_difference_base").notNull().default("0"),
    journalEntryId: uuid("journal_entry_id"),
    status: text("status", { enum: ["active", "reversed"] }).notNull().default("active"),
    reversedAt: ts("reversed_at"),
    reversalEntryId: uuid("reversal_entry_id"),
    reversalReason: text("reversal_reason"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("settlements_org_id_uq").on(t.orgId, t.id),
    index("settlements_debit_idx").on(t.orgId, t.debitItemId),
    index("settlements_credit_idx").on(t.orgId, t.creditItemId),
    foreignKey({ columns: [t.orgId, t.contactId], foreignColumns: [contacts.orgId, contacts.id] }),
    foreignKey({ columns: [t.orgId, t.journalEntryId], foreignColumns: [journalEntries.orgId, journalEntries.id] }),
    foreignKey({ columns: [t.orgId, t.reversalEntryId], foreignColumns: [journalEntries.orgId, journalEntries.id] }),
    check("settlements_amount_positive", sql`${t.amount} > 0`),
    check("settlements_distinct_items", sql`${t.debitItemId} <> ${t.creditItemId}`),
  ],
);

/**
 * The cash-basis projection of settlements: when a settlement relieves a
 * receivable or payable document, that document's own lines are recognized
 * here pro rata, dated the settlement date. Append-only; reversing a
 * settlement adds negating rows. See docs/accounting/cash-basis.md.
 */
export const cashBasisLines = pgTable(
  "cash_basis_lines",
  {
    id: id(),
    orgId: orgId(),
    /** The settlement (or reversal) entry this recognition belongs to — the drill-down anchor. */
    entryId: uuid("entry_id").notNull(),
    settlementId: uuid("settlement_id").notNull(),
    entryDate: day("entry_date").notNull(),
    /** The document line being recognized. */
    sourceEntryId: uuid("source_entry_id").notNull(),
    sourceLineId: uuid("source_line_id").notNull(),
    accountId: uuid("account_id").notNull(),
    baseAmount: money("base_amount").notNull(),
    currency: currencyCode("currency").notNull(),
    txnAmount: money("txn_amount").notNull(),
    contactId: uuid("contact_id"),
    itemId: uuid("item_id"),
    projectId: uuid("project_id"),
    classId: uuid("class_id"),
    departmentId: uuid("department_id"),
    locationId: uuid("location_id"),
    fundId: uuid("fund_id"),
    trustComponent: text("trust_component", { enum: ["principal", "income"] }),
    beneficiaryId: uuid("beneficiary_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("cash_basis_lines_account_idx").on(t.orgId, t.accountId, t.entryDate),
    index("cash_basis_lines_source_idx").on(t.orgId, t.sourceLineId),
    index("cash_basis_lines_entry_idx").on(t.orgId, t.entryId),
    foreignKey({ columns: [t.orgId, t.settlementId], foreignColumns: [settlements.orgId, settlements.id] }),
    foreignKey({ columns: [t.orgId, t.entryId], foreignColumns: [journalEntries.orgId, journalEntries.id] }),
    foreignKey({ columns: [t.orgId, t.sourceEntryId], foreignColumns: [journalEntries.orgId, journalEntries.id] }),
    foreignKey({ columns: [t.orgId, t.sourceLineId], foreignColumns: [journalLines.orgId, journalLines.id] }),
    foreignKey({ columns: [t.orgId, t.accountId], foreignColumns: [accounts.orgId, accounts.id] }),
  ],
);

/** A schedule that produces invoices, bills or journal entries. Each occurrence is produced once (recurring_runs). */
export const recurringTemplates = pgTable(
  "recurring_templates",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id),
    kind: text("kind", { enum: ["invoice", "bill", "journal"] }).notNull(),
    name: text("name").notNull(),
    frequency: text("frequency", { enum: ["weekly", "monthly", "quarterly", "yearly"] }).notNull(),
    interval: integer("interval").notNull().default(1),
    startDate: day("start_date").notNull(),
    endDate: day("end_date"),
    nextRunDate: day("next_run_date"),
    maxOccurrences: integer("max_occurrences"),
    occurrences: integer("occurrences").notNull().default(0),
    /** Issue (post) each occurrence, or leave it as a draft for review. */
    autoIssue: boolean("auto_issue").notNull().default(false),
    /** Email each issued invoice to the customer. */
    autoSend: boolean("auto_send").notNull().default(false),
    /** The document (or journal) as a draft payload. */
    template: jsonb("template").notNull(),
    status: text("status", { enum: ["active", "paused", "ended"] }).notNull().default("active"),
    lastRunAt: ts("last_run_at"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique("recurring_templates_org_id_uq").on(t.orgId, t.id), index("recurring_due_idx").on(t.status, t.nextRunDate)],
);

export const recurringRuns = pgTable(
  "recurring_runs",
  {
    id: id(),
    orgId: orgId(),
    templateId: uuid("template_id").notNull(),
    occurrenceDate: day("occurrence_date").notNull(),
    status: text("status", { enum: ["created", "failed", "skipped"] }).notNull(),
    documentId: uuid("document_id"),
    journalEntryId: uuid("journal_entry_id"),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("recurring_runs_once_uq").on(t.templateId, t.occurrenceDate),
    foreignKey({ columns: [t.orgId, t.templateId], foreignColumns: [recurringTemplates.orgId, recurringTemplates.id] }),
  ],
);
