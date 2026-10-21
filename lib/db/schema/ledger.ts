/**
 * The general ledger and the reference data every module posts against:
 * fiscal calendar, currencies and rates, the chart of accounts, dimensions,
 * contacts, items, sales-tax configuration, journal entries and lines, and
 * the cash-basis projection.
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
import { organizations } from "./core";

// ── Fiscal calendar ─────────────────────────────────────────────────────────

export const fiscalYears = pgTable(
  "fiscal_years",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id),
    name: text("name").notNull(),
    startDate: day("start_date").notNull(),
    endDate: day("end_date").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("fiscal_years_org_id_uq").on(t.orgId, t.id),
    unique("fiscal_years_org_start_uq").on(t.orgId, t.startDate),
    check("fiscal_years_range", sql`${t.endDate} > ${t.startDate}`),
  ],
);

/**
 * Twelve monthly periods per fiscal year. A closed period refuses postings
 * (enforced by the posting trigger); reopening needs the periods.reopen
 * permission and a reason, and both are recorded in period_events.
 */
export const fiscalPeriods = pgTable(
  "fiscal_periods",
  {
    id: id(),
    orgId: orgId(),
    fiscalYearId: uuid("fiscal_year_id").notNull(),
    periodNo: integer("period_no").notNull(),
    startDate: day("start_date").notNull(),
    endDate: day("end_date").notNull(),
    status: text("status", { enum: ["open", "closed"] }).notNull().default("open"),
    closedAt: ts("closed_at"),
    closedBy: uuid("closed_by"),
  },
  (t) => [
    unique("fiscal_periods_org_id_uq").on(t.orgId, t.id),
    unique("fiscal_periods_org_start_uq").on(t.orgId, t.startDate),
    index("fiscal_periods_lookup_idx").on(t.orgId, t.startDate, t.endDate),
    foreignKey({ columns: [t.orgId, t.fiscalYearId], foreignColumns: [fiscalYears.orgId, fiscalYears.id] }),
  ],
);

/** The history of closing and reopening, with the close checklist as it stood. */
export const periodEvents = pgTable(
  "period_events",
  {
    id: id(),
    orgId: orgId(),
    periodId: uuid("period_id").notNull(),
    action: text("action", { enum: ["close", "reopen", "lock_date_set"] }).notNull(),
    reason: text("reason"),
    checklist: jsonb("checklist"),
    actorUserId: uuid("actor_user_id"),
    createdAt: createdAt(),
  },
  (t) => [foreignKey({ columns: [t.orgId, t.periodId], foreignColumns: [fiscalPeriods.orgId, fiscalPeriods.id] })],
);

// ── Exchange rates ──────────────────────────────────────────────────────────

/**
 * Rates are rows, never edited once used: a posting stores the rate value it
 * used and this row's id as provenance, so updating rates never changes a
 * historical posting. `rate` is base-currency units per one unit of
 * `currency`.
 */
export const exchangeRates = pgTable(
  "exchange_rates",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id),
    currency: currencyCode("currency").notNull(),
    baseCurrency: currencyCode("base_currency").notNull(),
    rateDate: day("rate_date").notNull(),
    rate: fxRate("rate").notNull(),
    source: text("source").notNull(),
    sourceRef: text("source_ref"),
    fetchedAt: ts("fetched_at"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("exchange_rates_org_id_uq").on(t.orgId, t.id),
    // One rate per day per source; rates typed on a transaction are each their own row.
    uniqueIndex("exchange_rates_org_cur_date_src_uq")
      .on(t.orgId, t.currency, t.rateDate, t.source)
      .where(sql`${t.source} <> 'transaction'`),
    index("exchange_rates_lookup_idx").on(t.orgId, t.currency, t.rateDate),
    check("exchange_rates_positive", sql`${t.rate} > 0`),
  ],
);

// ── Chart of accounts ───────────────────────────────────────────────────────

export const ACCOUNT_TYPES = ["asset", "liability", "equity", "income", "expense"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const ACCOUNT_SUBTYPES = [
  // assets
  "bank",
  "cash",
  "clearing",
  "accounts_receivable",
  "inventory",
  "other_current_asset",
  "prepaid_expense",
  "fixed_asset",
  "accumulated_depreciation",
  "other_asset",
  // liabilities
  "credit_card",
  "accounts_payable",
  "sales_tax_payable",
  "payroll_liability",
  "customer_deposits",
  "other_current_liability",
  "long_term_liability",
  // equity
  "owner_equity",
  "owner_contributions",
  "owner_draws",
  "retained_earnings",
  "opening_balance_equity",
  "net_assets_unrestricted",
  "net_assets_restricted",
  "trust_principal",
  "trust_income",
  // income
  "operating_income",
  "other_income",
  // expense
  "cost_of_goods_sold",
  "operating_expense",
  "payroll_expense",
  "depreciation_expense",
  "other_expense",
] as const;
export type AccountSubtype = (typeof ACCOUNT_SUBTYPES)[number];

export const accounts = pgTable(
  "accounts",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id),
    code: text("code").notNull(),
    name: text("name").notNull(),
    type: text("type", { enum: ACCOUNT_TYPES }).notNull(),
    subtype: text("subtype", { enum: ACCOUNT_SUBTYPES }).notNull(),
    parentId: uuid("parent_id"),
    description: text("description"),
    /** If set, every line on this account is in this currency (a foreign-currency bank account). */
    currency: currencyCode("currency"),
    /**
     * A named role the application posts to (accounts_receivable,
     * realized_fx, rounding, …); at most one account per role per org.
     */
    systemKey: text("system_key"),
    /**
     * A control account belongs to a subledger (receivables, payables,
     * inventory, fixed assets, payroll). Manual journal entries may not post
     * to it, so the subledger and the ledger always agree.
     */
    control: text("control", { enum: ["receivables", "payables", "inventory", "fixed_assets", "customer_deposits", "vendor_prepayments"] }),
    /** Section of the cash-flow statement (indirect method); defaulted from subtype. */
    cashFlowSection: text("cash_flow_section", { enum: ["cash", "operating", "investing", "financing", "none"] }),
    /** For intercompany balances in consolidation: the counterparty organization. */
    intercompanyOrgId: uuid("intercompany_org_id"),
    isArchived: boolean("is_archived").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("accounts_org_id_uq").on(t.orgId, t.id),
    unique("accounts_org_code_uq").on(t.orgId, t.code),
    uniqueIndex("accounts_org_system_key_uq").on(t.orgId, t.systemKey).where(sql`${t.systemKey} is not null`),
    foreignKey({ columns: [t.orgId, t.parentId], foreignColumns: [t.orgId, t.id] }),
    check("accounts_not_own_parent", sql`${t.parentId} is null or ${t.parentId} <> ${t.id}`),
  ],
);

/** Bank-side details for bank, credit-card, cash and clearing accounts. */
export const bankAccountDetails = pgTable(
  "bank_account_details",
  {
    accountId: uuid("account_id").primaryKey(),
    orgId: orgId(),
    institution: text("institution"),
    /** Last four digits only. */
    mask: text("mask"),
    accountKind: text("account_kind", { enum: ["checking", "savings", "credit_card", "cash", "clearing", "payment_processor", "other"] }).notNull(),
    feedConnectionId: uuid("feed_connection_id"),
    feedAccountRef: text("feed_account_ref"),
    createdAt: createdAt(),
  },
  (t) => [foreignKey({ columns: [t.orgId, t.accountId], foreignColumns: [accounts.orgId, accounts.id] })],
);

// ── Dimensions ──────────────────────────────────────────────────────────────

/**
 * Line-level analysis dimensions: classes, departments, locations and funds
 * (nonprofit). Projects have their own table because they carry customers,
 * rates and budgets.
 */
export const dimensionValues = pgTable(
  "dimension_values",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id),
    kind: text("kind", { enum: ["class", "department", "location", "fund"] }).notNull(),
    code: text("code"),
    name: text("name").notNull(),
    parentId: uuid("parent_id"),
    /** Funds only: the donor restriction on the fund's net assets. */
    restriction: text("restriction", { enum: ["without_donor_restrictions", "with_donor_restrictions_temporary", "with_donor_restrictions_perpetual"] }),
    isArchived: boolean("is_archived").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    unique("dimension_values_org_id_uq").on(t.orgId, t.id),
    unique("dimension_values_org_kind_name_uq").on(t.orgId, t.kind, t.name),
    foreignKey({ columns: [t.orgId, t.parentId], foreignColumns: [t.orgId, t.id] }),
    check("dimension_fund_restriction", sql`(${t.kind} = 'fund') = (${t.restriction} is not null)`),
  ],
);

// ── Contacts ────────────────────────────────────────────────────────────────

export const paymentTerms = pgTable(
  "payment_terms",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id),
    name: text("name").notNull(),
    daysDue: integer("days_due").notNull(),
    /** Early-payment discount, e.g. 2/10 net 30 → 0.02 within 10 days. */
    discountRate: rate("discount_rate"),
    discountDays: integer("discount_days"),
    isArchived: boolean("is_archived").notNull().default(false),
  },
  (t) => [unique("payment_terms_org_id_uq").on(t.orgId, t.id), unique("payment_terms_org_name_uq").on(t.orgId, t.name)],
);

export interface Address {
  line1?: string;
  line2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
}

/** Customers, vendors, employees and beneficiaries are one table: one party can be several. */
export const contacts = pgTable(
  "contacts",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id),
    displayName: text("display_name").notNull(),
    companyName: text("company_name"),
    isCustomer: boolean("is_customer").notNull().default(false),
    isVendor: boolean("is_vendor").notNull().default(false),
    isEmployee: boolean("is_employee").notNull().default(false),
    /** Trust/estate beneficiary. */
    isBeneficiary: boolean("is_beneficiary").notNull().default(false),
    email: text("email"),
    phone: text("phone"),
    website: text("website"),
    /** Document currency for this contact; null means the organization's base currency. */
    currency: currencyCode("currency"),
    paymentTermsId: uuid("payment_terms_id"),
    billingAddress: jsonb("billing_address").$type<Address>(),
    shippingAddress: jsonb("shipping_address").$type<Address>(),
    taxExempt: boolean("tax_exempt").notNull().default(false),
    taxExemptionReason: text("tax_exemption_reason"),
    taxExemptionCertificate: text("tax_exemption_certificate"),
    /** Recipient of a 1099-NEC/MISC (vendors); used by the Gideon Tax export only. */
    is1099: boolean("is_1099").notNull().default(false),
    defaultIncomeAccountId: uuid("default_income_account_id"),
    defaultExpenseAccountId: uuid("default_expense_account_id"),
    notes: text("notes"),
    isArchived: boolean("is_archived").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("contacts_org_id_uq").on(t.orgId, t.id),
    index("contacts_org_name_idx").on(t.orgId, t.displayName),
    foreignKey({ columns: [t.orgId, t.paymentTermsId], foreignColumns: [paymentTerms.orgId, paymentTerms.id] }),
    foreignKey({ columns: [t.orgId, t.defaultIncomeAccountId], foreignColumns: [accounts.orgId, accounts.id] }),
    foreignKey({ columns: [t.orgId, t.defaultExpenseAccountId], foreignColumns: [accounts.orgId, accounts.id] }),
  ],
);

export const contactPersons = pgTable(
  "contact_persons",
  {
    id: id(),
    orgId: orgId(),
    contactId: uuid("contact_id").notNull(),
    name: text("name").notNull(),
    email: text("email"),
    phone: text("phone"),
    role: text("role"),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    unique("contact_persons_org_id_uq").on(t.orgId, t.id),
    foreignKey({ columns: [t.orgId, t.contactId], foreignColumns: [contacts.orgId, contacts.id] }).onDelete("cascade"),
  ],
);

// ── Projects ────────────────────────────────────────────────────────────────

export const projects = pgTable(
  "projects",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id),
    code: text("code"),
    name: text("name").notNull(),
    customerId: uuid("customer_id"),
    status: text("status", { enum: ["active", "completed", "on_hold", "cancelled"] }).notNull().default("active"),
    billingMethod: text("billing_method", { enum: ["time_and_materials", "fixed_fee", "non_billable"] }).notNull().default("time_and_materials"),
    hourlyRate: unitAmount("hourly_rate"),
    fixedFee: money("fixed_fee"),
    budgetAmount: money("budget_amount"),
    startDate: day("start_date"),
    endDate: day("end_date"),
    description: text("description"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("projects_org_id_uq").on(t.orgId, t.id),
    unique("projects_org_name_uq").on(t.orgId, t.name),
    foreignKey({ columns: [t.orgId, t.customerId], foreignColumns: [contacts.orgId, contacts.id] }),
  ],
);

// ── Items ───────────────────────────────────────────────────────────────────

export const inventoryLocations = pgTable(
  "inventory_locations",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id),
    code: text("code").notNull(),
    name: text("name").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    isArchived: boolean("is_archived").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    unique("inventory_locations_org_id_uq").on(t.orgId, t.id),
    unique("inventory_locations_org_code_uq").on(t.orgId, t.code),
    uniqueIndex("inventory_locations_one_default").on(t.orgId).where(sql`${t.isDefault}`),
  ],
);

// ── Sales tax ───────────────────────────────────────────────────────────────

/**
 * A taxing authority the organization collects for. Gideon Books ships with
 * no rates: the organization enters what its authorities publish, with the
 * dates they apply.
 */
export const taxJurisdictions = pgTable(
  "tax_jurisdictions",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id),
    name: text("name").notNull(),
    code: text("code"),
    /** Who is remitted to (a contact marked vendor), for remittance payments. */
    authorityContactId: uuid("authority_contact_id"),
    /** Where collected tax is owed. */
    liabilityAccountId: uuid("liability_account_id").notNull(),
    /** Where recoverable tax on purchases is recorded (VAT-style); null if purchase tax is not recoverable. */
    recoverableAccountId: uuid("recoverable_account_id"),
    filingFrequency: text("filing_frequency", { enum: ["monthly", "quarterly", "semiannual", "annual"] }),
    isArchived: boolean("is_archived").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    unique("tax_jurisdictions_org_id_uq").on(t.orgId, t.id),
    unique("tax_jurisdictions_org_name_uq").on(t.orgId, t.name),
    foreignKey({ columns: [t.orgId, t.liabilityAccountId], foreignColumns: [accounts.orgId, accounts.id] }),
    foreignKey({ columns: [t.orgId, t.recoverableAccountId], foreignColumns: [accounts.orgId, accounts.id] }),
    foreignKey({ columns: [t.orgId, t.authorityContactId], foreignColumns: [contacts.orgId, contacts.id] }),
  ],
);

/** A rate with the dates it applies. A change of rate is a new row; old documents keep the old rate. */
export const taxRates = pgTable(
  "tax_rates",
  {
    id: id(),
    orgId: orgId(),
    jurisdictionId: uuid("jurisdiction_id").notNull(),
    name: text("name").notNull(),
    rate: rate("rate").notNull(),
    effectiveFrom: day("effective_from").notNull(),
    /** Last day it applies; null = until further notice. */
    effectiveTo: day("effective_to"),
    /** Source the organization recorded for the rate (a notice, a URL). */
    sourceNote: text("source_note"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("tax_rates_org_id_uq").on(t.orgId, t.id),
    foreignKey({ columns: [t.orgId, t.jurisdictionId], foreignColumns: [taxJurisdictions.orgId, taxJurisdictions.id] }),
    check("tax_rates_range", sql`${t.rate} >= 0 and ${t.rate} < 1`),
    check("tax_rates_dates", sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`),
  ],
);

/** What a line is taxed with: one or more jurisdictions, applied in order (compound ones on the running total). */
export const taxCodes = pgTable(
  "tax_codes",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id),
    name: text("name").notNull(),
    description: text("description"),
    /** An exempt / out-of-scope code computes no tax but is still recorded on the line. */
    isExempt: boolean("is_exempt").notNull().default(false),
    isArchived: boolean("is_archived").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [unique("tax_codes_org_id_uq").on(t.orgId, t.id), unique("tax_codes_org_name_uq").on(t.orgId, t.name)],
);

export const taxCodeComponents = pgTable(
  "tax_code_components",
  {
    id: id(),
    orgId: orgId(),
    taxCodeId: uuid("tax_code_id").notNull(),
    jurisdictionId: uuid("jurisdiction_id").notNull(),
    sequence: integer("sequence").notNull(),
    /** Compound: computed on the line amount plus the taxes before it. */
    isCompound: boolean("is_compound").notNull().default(false),
  },
  (t) => [
    unique("tax_code_components_seq_uq").on(t.orgId, t.taxCodeId, t.sequence),
    foreignKey({ columns: [t.orgId, t.taxCodeId], foreignColumns: [taxCodes.orgId, taxCodes.id] }).onDelete("cascade"),
    foreignKey({ columns: [t.orgId, t.jurisdictionId], foreignColumns: [taxJurisdictions.orgId, taxJurisdictions.id] }),
  ],
);

export const items = pgTable(
  "items",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id),
    /** stock items are costed and counted; non_stock are bought or sold without inventory; service is labor and fees. */
    kind: text("kind", { enum: ["service", "non_stock", "stock"] }).notNull(),
    sku: text("sku"),
    name: text("name").notNull(),
    description: text("description"),
    unit: text("unit").notNull().default("ea"),
    salePrice: unitAmount("sale_price"),
    purchaseCost: unitAmount("purchase_cost"),
    incomeAccountId: uuid("income_account_id"),
    /** Expense for purchases of service/non-stock items; cost of goods sold for stock items. */
    expenseAccountId: uuid("expense_account_id"),
    /** Stock items only. */
    inventoryAccountId: uuid("inventory_account_id"),
    saleTaxCodeId: uuid("sale_tax_code_id"),
    purchaseTaxCodeId: uuid("purchase_tax_code_id"),
    reorderLevel: quantity("reorder_level"),
    reorderQuantity: quantity("reorder_quantity"),
    preferredVendorId: uuid("preferred_vendor_id"),
    isArchived: boolean("is_archived").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("items_org_id_uq").on(t.orgId, t.id),
    uniqueIndex("items_org_sku_uq").on(t.orgId, t.sku).where(sql`${t.sku} is not null`),
    foreignKey({ columns: [t.orgId, t.incomeAccountId], foreignColumns: [accounts.orgId, accounts.id] }),
    foreignKey({ columns: [t.orgId, t.expenseAccountId], foreignColumns: [accounts.orgId, accounts.id] }),
    foreignKey({ columns: [t.orgId, t.inventoryAccountId], foreignColumns: [accounts.orgId, accounts.id] }),
    foreignKey({ columns: [t.orgId, t.saleTaxCodeId], foreignColumns: [taxCodes.orgId, taxCodes.id] }),
    foreignKey({ columns: [t.orgId, t.purchaseTaxCodeId], foreignColumns: [taxCodes.orgId, taxCodes.id] }),
    foreignKey({ columns: [t.orgId, t.preferredVendorId], foreignColumns: [contacts.orgId, contacts.id] }),
    check("items_stock_accounts", sql`${t.kind} <> 'stock' or (${t.inventoryAccountId} is not null and ${t.expenseAccountId} is not null)`),
  ],
);

// ── Journal ─────────────────────────────────────────────────────────────────

export const ENTRY_KINDS = [
  "manual",
  "opening_balance",
  "invoice",
  "credit_note",
  "write_off",
  "sales_receipt",
  "customer_payment",
  "customer_deposit",
  "customer_refund",
  "bill",
  "vendor_credit",
  "expense",
  "vendor_payment",
  "vendor_prepayment",
  "vendor_refund",
  "settlement",
  "bank",
  "transfer",
  "inventory",
  "depreciation",
  "asset",
  "fx_revaluation",
  "payroll",
  "sales_tax",
  "payment_provider",
  "reconciliation_adjustment",
  "intercompany",
] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

/**
 * How an entry appears in cash-basis reports (docs/accounting/cash-basis.md):
 *  as_is      — included on its date unchanged;
 *  deferred   — a receivable/payable document, recognized only as settled;
 *  settlement — its receivable/payable lines on the document side are
 *               replaced by the pro-rata recognition in cash_basis_lines.
 */
export const CASH_BASIS_TREATMENTS = ["as_is", "deferred", "settlement"] as const;

export const journalEntries = pgTable(
  "journal_entries",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id),
    /** Assigned when posted; gapless per organization. */
    entryNumber: integer("entry_number"),
    status: text("status", { enum: ["draft", "posted"] }).notNull().default("draft"),
    kind: text("kind", { enum: ENTRY_KINDS }).notNull(),
    /** Posting date: the date the entry affects balances and the period it falls in. */
    entryDate: day("entry_date").notNull(),
    /** Date on the source document, which may differ from the posting date. */
    documentDate: day("document_date"),
    periodId: uuid("period_id"),
    description: text("description").notNull().default(""),
    /** The record that produced the entry (invoice, payment, bank transaction, asset…). */
    sourceType: text("source_type"),
    sourceId: uuid("source_id"),
    /** Human reference: INV-0042, a check number. */
    sourceRef: text("source_ref"),
    idempotencyKey: text("idempotency_key"),
    requestHash: text("request_hash"),
    cashBasis: text("cash_basis", { enum: CASH_BASIS_TREATMENTS }).notNull().default("as_is"),
    /** This entry reverses that one (each entry can be reversed once). */
    reversesEntryId: uuid("reverses_entry_id"),
    reversalReason: text("reversal_reason"),
    /** Revaluations and accruals reverse themselves on this date. */
    autoReverseOn: day("auto_reverse_on"),
    /** A period-end adjusting entry (for reports that separate them). */
    isAdjusting: boolean("is_adjusting").notNull().default(false),
    origin: text("origin", { enum: ["ui", "api", "job", "import", "webhook", "system", "cli"] }).notNull(),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    postedBy: uuid("posted_by"),
    postedAt: ts("posted_at"),
  },
  (t) => [
    unique("journal_entries_org_id_uq").on(t.orgId, t.id),
    uniqueIndex("journal_entries_org_number_uq").on(t.orgId, t.entryNumber).where(sql`${t.entryNumber} is not null`),
    uniqueIndex("journal_entries_org_idem_uq").on(t.orgId, t.idempotencyKey).where(sql`${t.idempotencyKey} is not null`),
    uniqueIndex("journal_entries_reverses_uq").on(t.orgId, t.reversesEntryId).where(sql`${t.reversesEntryId} is not null`),
    index("journal_entries_org_date_idx").on(t.orgId, t.entryDate),
    index("journal_entries_source_idx").on(t.orgId, t.sourceType, t.sourceId),
    foreignKey({ columns: [t.orgId, t.periodId], foreignColumns: [fiscalPeriods.orgId, fiscalPeriods.id] }),
    foreignKey({ columns: [t.orgId, t.reversesEntryId], foreignColumns: [t.orgId, t.id] }),
    check("journal_entries_posted_numbered", sql`${t.status} = 'draft' or (${t.entryNumber} is not null and ${t.periodId} is not null and ${t.postedAt} is not null)`),
  ],
);

/**
 * One line of an entry. `base_amount` is signed in the organization's base
 * currency (debit positive, credit negative) and every posted entry's lines
 * sum to zero. `txn_amount` is the same line in `currency` at `fx_rate`.
 *
 * `open_item_type`/`open_item_id` tie a line on a receivable, payable,
 * deposit or prepayment account to the document or payment it belongs to:
 * the subledger is these lines, so it always agrees with the ledger.
 */
export const journalLines = pgTable(
  "journal_lines",
  {
    id: id(),
    orgId: orgId(),
    entryId: uuid("entry_id").notNull(),
    lineNo: integer("line_no").notNull(),
    accountId: uuid("account_id").notNull(),
    description: text("description"),
    baseAmount: money("base_amount").notNull(),
    currency: currencyCode("currency").notNull(),
    txnAmount: money("txn_amount").notNull(),
    fxRate: fxRate("fx_rate").notNull().default("1"),
    exchangeRateId: uuid("exchange_rate_id"),
    contactId: uuid("contact_id"),
    openItemType: text("open_item_type", { enum: ["document", "payment"] }),
    openItemId: uuid("open_item_id"),
    itemId: uuid("item_id"),
    quantity: quantity("quantity"),
    projectId: uuid("project_id"),
    classId: uuid("class_id"),
    departmentId: uuid("department_id"),
    locationId: uuid("location_id"),
    fundId: uuid("fund_id"),
    /** Trust and estate accounting: which side of the trust the line belongs to. */
    trustComponent: text("trust_component", { enum: ["principal", "income"] }),
    beneficiaryId: uuid("beneficiary_id"),
    taxRateId: uuid("tax_rate_id"),
    /** The document line this ledger line came from. */
    sourceLineId: uuid("source_line_id"),
    /** Billable to a customer through a project (time & materials). */
    billableStatus: text("billable_status", { enum: ["billable", "billed", "not_billable"] }),
  },
  (t) => [
    unique("journal_lines_org_id_uq").on(t.orgId, t.id),
    unique("journal_lines_entry_line_uq").on(t.entryId, t.lineNo),
    index("journal_lines_account_idx").on(t.orgId, t.accountId),
    index("journal_lines_entry_idx").on(t.entryId),
    index("journal_lines_open_item_idx").on(t.orgId, t.openItemId).where(sql`${t.openItemId} is not null`),
    index("journal_lines_contact_idx").on(t.orgId, t.contactId).where(sql`${t.contactId} is not null`),
    index("journal_lines_project_idx").on(t.orgId, t.projectId).where(sql`${t.projectId} is not null`),
    foreignKey({ columns: [t.orgId, t.entryId], foreignColumns: [journalEntries.orgId, journalEntries.id] }).onDelete("cascade"),
    foreignKey({ columns: [t.orgId, t.accountId], foreignColumns: [accounts.orgId, accounts.id] }),
    foreignKey({ columns: [t.orgId, t.exchangeRateId], foreignColumns: [exchangeRates.orgId, exchangeRates.id] }),
    foreignKey({ columns: [t.orgId, t.contactId], foreignColumns: [contacts.orgId, contacts.id] }),
    foreignKey({ columns: [t.orgId, t.itemId], foreignColumns: [items.orgId, items.id] }),
    foreignKey({ columns: [t.orgId, t.projectId], foreignColumns: [projects.orgId, projects.id] }),
    foreignKey({ columns: [t.orgId, t.classId], foreignColumns: [dimensionValues.orgId, dimensionValues.id] }),
    foreignKey({ columns: [t.orgId, t.departmentId], foreignColumns: [dimensionValues.orgId, dimensionValues.id] }),
    foreignKey({ columns: [t.orgId, t.locationId], foreignColumns: [dimensionValues.orgId, dimensionValues.id] }),
    foreignKey({ columns: [t.orgId, t.fundId], foreignColumns: [dimensionValues.orgId, dimensionValues.id] }),
    foreignKey({ columns: [t.orgId, t.beneficiaryId], foreignColumns: [contacts.orgId, contacts.id] }),
    foreignKey({ columns: [t.orgId, t.taxRateId], foreignColumns: [taxRates.orgId, taxRates.id] }),
    check("journal_lines_open_item_pair", sql`(${t.openItemType} is null) = (${t.openItemId} is null)`),
    check("journal_lines_fx_positive", sql`${t.fxRate} > 0`),
  ],
);
