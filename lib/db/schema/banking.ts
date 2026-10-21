/**
 * Banking: what the bank says happened (imported or fed transactions, kept
 * separate from the ledger), how it is matched to what the books say
 * (journal lines), statement reconciliation, and categorization rules.
 *
 * Bank transactions are observations, never postings. A posting happens only
 * when a person (or a rule they allowed to post) categorizes, transfers or
 * records a payment from a transaction. Journal lines are immutable, so a
 * line being matched or cleared is recorded here, not on the line.
 */
import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, jsonb, pgTable, text, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, currencyCode, day, id, money, orgId, ts, updatedAt } from "./_columns";
import { integrationConnections, organizations } from "./core";
import { accounts, journalEntries, journalLines } from "./ledger";

/** How a CSV file's columns map to a transaction. Columns are zero-based indexes. */
export interface CsvMappingConfig {
  /** "," ";" "\t" or "|"; null detects it. */
  delimiter: string | null;
  hasHeader: boolean;
  /** Lines before the header (or the first data row) to ignore — bank preambles. */
  skipRows: number;
  dateColumn: number;
  dateFormat: "YYYY-MM-DD" | "MM/DD/YYYY" | "DD/MM/YYYY" | "M/D/YY" | "DD.MM.YYYY" | "YYYY/MM/DD";
  amountMode: "single" | "debit_credit";
  amountColumn: number | null;
  /** Money out (bank-statement "debit" / "withdrawal"). */
  debitColumn: number | null;
  /** Money in (bank-statement "credit" / "deposit"). */
  creditColumn: number | null;
  /** Flip the sign (credit-card exports that show charges as positive). */
  invertSign: boolean;
  /** Amounts written 1.234,56. */
  decimalComma: boolean;
  descriptionColumn: number;
  payeeColumn: number | null;
  referenceColumn: number | null;
  balanceColumn: number | null;
}

export const bankCsvMappings = pgTable(
  "bank_csv_mappings",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id),
    name: text("name").notNull(),
    /** The account it was made for (offered first there); usable for any account. */
    accountId: uuid("account_id"),
    config: jsonb("config").$type<CsvMappingConfig>().notNull(),
    /** Header names when saved, to recognize the same export again. */
    headerSignature: text("header_signature"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("bank_csv_mappings_org_id_uq").on(t.orgId, t.id),
    unique("bank_csv_mappings_org_name_uq").on(t.orgId, t.name),
    foreignKey({ columns: [t.orgId, t.accountId], foreignColumns: [accounts.orgId, accounts.id] }),
  ],
);

/** One import: a CSV file or a feed sync. Provenance for every transaction it brought in. */
export const bankImportBatches = pgTable(
  "bank_import_batches",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id),
    accountId: uuid("account_id").notNull(),
    source: text("source", { enum: ["csv", "feed"] }).notNull(),
    fileName: text("file_name"),
    fileSha256: text("file_sha256"),
    /** The original file, kept as an attachment. */
    attachmentId: uuid("attachment_id"),
    mappingId: uuid("mapping_id"),
    /** The mapping as it was used. */
    mappingSnapshot: jsonb("mapping_snapshot").$type<CsvMappingConfig>(),
    connectionId: uuid("connection_id"),
    totalRows: integer("total_rows").notNull().default(0),
    importedCount: integer("imported_count").notNull().default(0),
    duplicateCount: integer("duplicate_count").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    status: text("status", { enum: ["completed", "undone"] }).notNull().default("completed"),
    undoneAt: ts("undone_at"),
    undoneBy: uuid("undone_by"),
    undoReason: text("undo_reason"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("bank_import_batches_org_id_uq").on(t.orgId, t.id),
    index("bank_import_batches_account_idx").on(t.orgId, t.accountId, t.createdAt),
    foreignKey({ columns: [t.orgId, t.accountId], foreignColumns: [accounts.orgId, accounts.id] }),
    foreignKey({ columns: [t.orgId, t.mappingId], foreignColumns: [bankCsvMappings.orgId, bankCsvMappings.id] }),
    foreignKey({ columns: [t.orgId, t.connectionId], foreignColumns: [integrationConnections.orgId, integrationConnections.id] }),
  ],
);

/** Every row of every import exactly as received (append-only), with what became of it. */
export const bankImportRows = pgTable(
  "bank_import_rows",
  {
    id: id(),
    orgId: orgId(),
    batchId: uuid("batch_id").notNull(),
    rowNumber: integer("row_number").notNull(),
    /** CSV: { cells: string[] }; feed: the provider's transaction object. */
    raw: jsonb("raw").notNull(),
    outcome: text("outcome", { enum: ["imported", "duplicate", "error", "skipped"] }).notNull(),
    message: text("message"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("bank_import_rows_org_id_uq").on(t.orgId, t.id),
    index("bank_import_rows_batch_idx").on(t.orgId, t.batchId, t.rowNumber),
    foreignKey({ columns: [t.orgId, t.batchId], foreignColumns: [bankImportBatches.orgId, bankImportBatches.id] }),
  ],
);

export const BANK_TXN_STATUSES = ["unreviewed", "matched", "categorized", "excluded", "removed"] as const;
export type BankTxnStatus = (typeof BANK_TXN_STATUSES)[number];

export const bankTransactions = pgTable(
  "bank_transactions",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id),
    accountId: uuid("account_id").notNull(),
    postedDate: day("posted_date").notNull(),
    /** Signed in the account's currency: positive is money into the account. */
    amount: money("amount").notNull(),
    currency: currencyCode("currency").notNull(),
    description: text("description").notNull().default(""),
    payee: text("payee"),
    reference: text("reference"),
    /** The running balance the bank reported, if any. */
    bankBalance: money("bank_balance"),
    /** The provider's id for the transaction (feeds). */
    externalId: text("external_id"),
    /** Account + date + amount + normalized description + occurrence within the file. */
    fingerprint: text("fingerprint").notNull(),
    batchId: uuid("batch_id"),
    rawRowId: uuid("raw_row_id"),
    /** A feed transaction that looks like one already imported from a file. */
    possibleDuplicateOfId: uuid("possible_duplicate_of_id"),
    status: text("status", { enum: BANK_TXN_STATUSES }).notNull().default("unreviewed"),
    /** Why it was excluded or removed. */
    statusReason: text("status_reason"),
    /** The rule that matched it (suggested or applied). */
    ruleId: uuid("rule_id"),
    /** Posted by a rule in auto mode; still waits for a person to confirm. */
    autoCategorized: boolean("auto_categorized").notNull().default(false),
    matchGroupId: uuid("match_group_id"),
    reviewedBy: uuid("reviewed_by"),
    reviewedAt: ts("reviewed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("bank_transactions_org_id_uq").on(t.orgId, t.id),
    uniqueIndex("bank_transactions_fingerprint_uq").on(t.orgId, t.accountId, t.fingerprint).where(sql`${t.status} <> 'removed'`),
    uniqueIndex("bank_transactions_external_uq").on(t.orgId, t.accountId, t.externalId).where(sql`${t.externalId} is not null and ${t.status} <> 'removed'`),
    index("bank_transactions_account_date_idx").on(t.orgId, t.accountId, t.postedDate),
    index("bank_transactions_status_idx").on(t.orgId, t.status),
    foreignKey({ columns: [t.orgId, t.accountId], foreignColumns: [accounts.orgId, accounts.id] }),
    foreignKey({ columns: [t.orgId, t.batchId], foreignColumns: [bankImportBatches.orgId, bankImportBatches.id] }),
    foreignKey({ columns: [t.orgId, t.possibleDuplicateOfId], foreignColumns: [t.orgId, t.id] }),
  ],
);

/**
 * A match: bank transactions on one account and the journal lines on that
 * account they correspond to. The sums are equal. A categorization or a
 * transfer made from a transaction is a match with the entry it posted.
 */
export const bankMatchGroups = pgTable(
  "bank_match_groups",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id),
    accountId: uuid("account_id").notNull(),
    kind: text("kind", { enum: ["match", "categorized", "transfer", "payment"] }).notNull(),
    /** The entry this group posted (categorization, transfer). */
    entryId: uuid("entry_id"),
    ruleId: uuid("rule_id"),
    status: text("status", { enum: ["active", "undone"] }).notNull().default("active"),
    undoneAt: ts("undone_at"),
    undoneBy: uuid("undone_by"),
    undoReason: text("undo_reason"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("bank_match_groups_org_id_uq").on(t.orgId, t.id),
    index("bank_match_groups_entry_idx").on(t.orgId, t.entryId),
    foreignKey({ columns: [t.orgId, t.accountId], foreignColumns: [accounts.orgId, accounts.id] }),
    foreignKey({ columns: [t.orgId, t.entryId], foreignColumns: [journalEntries.orgId, journalEntries.id] }),
  ],
);

export const bankMatchItems = pgTable(
  "bank_match_items",
  {
    id: id(),
    orgId: orgId(),
    groupId: uuid("group_id").notNull(),
    bankTransactionId: uuid("bank_transaction_id"),
    journalLineId: uuid("journal_line_id"),
    /** Signed, in the account's currency. */
    amount: money("amount").notNull(),
    active: boolean("active").notNull().default(true),
  },
  (t) => [
    uniqueIndex("bank_match_items_txn_uq").on(t.orgId, t.bankTransactionId).where(sql`${t.active} and ${t.bankTransactionId} is not null`),
    uniqueIndex("bank_match_items_line_uq").on(t.orgId, t.journalLineId).where(sql`${t.active} and ${t.journalLineId} is not null`),
    index("bank_match_items_group_idx").on(t.orgId, t.groupId),
    foreignKey({ columns: [t.orgId, t.groupId], foreignColumns: [bankMatchGroups.orgId, bankMatchGroups.id] }),
    foreignKey({ columns: [t.orgId, t.bankTransactionId], foreignColumns: [bankTransactions.orgId, bankTransactions.id] }),
    foreignKey({ columns: [t.orgId, t.journalLineId], foreignColumns: [journalLines.orgId, journalLines.id] }),
    check("bank_match_items_one_side", sql`(${t.bankTransactionId} is null) <> (${t.journalLineId} is null)`),
  ],
);

/** A statement reconciliation. Its opening balance is the previous completed one's ending balance. */
export const reconciliations = pgTable(
  "reconciliations",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id),
    accountId: uuid("account_id").notNull(),
    statementDate: day("statement_date").notNull(),
    statementBalance: money("statement_balance").notNull(),
    openingBalance: money("opening_balance").notNull(),
    status: text("status", { enum: ["in_progress", "completed", "undone"] }).notNull().default("in_progress"),
    clearedBalance: money("cleared_balance"),
    difference: money("difference"),
    /** Posted when a person accepted a discrepancy, with their reason. */
    adjustmentEntryId: uuid("adjustment_entry_id"),
    adjustmentReason: text("adjustment_reason"),
    completedBy: uuid("completed_by"),
    completedAt: ts("completed_at"),
    undoneBy: uuid("undone_by"),
    undoneAt: ts("undone_at"),
    undoReason: text("undo_reason"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("reconciliations_org_id_uq").on(t.orgId, t.id),
    uniqueIndex("reconciliations_one_in_progress").on(t.orgId, t.accountId).where(sql`${t.status} = 'in_progress'`),
    index("reconciliations_account_idx").on(t.orgId, t.accountId, t.statementDate),
    foreignKey({ columns: [t.orgId, t.accountId], foreignColumns: [accounts.orgId, accounts.id] }),
    foreignKey({ columns: [t.orgId, t.adjustmentEntryId], foreignColumns: [journalEntries.orgId, journalEntries.id] }),
  ],
);

/** A journal line cleared by (or, while in progress, checked in) a reconciliation. */
export const reconciliationLines = pgTable(
  "reconciliation_lines",
  {
    id: id(),
    orgId: orgId(),
    reconciliationId: uuid("reconciliation_id").notNull(),
    journalLineId: uuid("journal_line_id").notNull(),
    amount: money("amount").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("reconciliation_lines_line_uq").on(t.orgId, t.journalLineId).where(sql`${t.active}`),
    index("reconciliation_lines_rec_idx").on(t.orgId, t.reconciliationId),
    foreignKey({ columns: [t.orgId, t.reconciliationId], foreignColumns: [reconciliations.orgId, reconciliations.id] }),
    foreignKey({ columns: [t.orgId, t.journalLineId], foreignColumns: [journalLines.orgId, journalLines.id] }),
  ],
);

export interface BankRuleConditions {
  descriptionContains?: string | null;
  descriptionEquals?: string | null;
  descriptionRegex?: string | null;
  payeeContains?: string | null;
  /** Absolute amounts, inclusive. */
  minAmount?: string | null;
  maxAmount?: string | null;
  direction?: "in" | "out" | "any";
  accountId?: string | null;
}

export interface BankRuleSplit {
  accountId: string;
  /** Percent of what is left after fixed amounts (percent splits sum to 100). */
  percent?: string | null;
  /** A fixed amount (absolute). */
  amount?: string | null;
  description?: string | null;
}

export interface BankRuleActions {
  splits: BankRuleSplit[];
  contactId?: string | null;
  projectId?: string | null;
  classId?: string | null;
  departmentId?: string | null;
  locationId?: string | null;
  fundId?: string | null;
  memo?: string | null;
}

export const bankRules = pgTable(
  "bank_rules",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id),
    name: text("name").notNull(),
    /** Lowest first; the first matching rule wins. */
    priority: integer("priority").notNull(),
    conditions: jsonb("conditions").$type<BankRuleConditions>().notNull(),
    actions: jsonb("actions").$type<BankRuleActions>().notNull(),
    mode: text("mode", { enum: ["suggest", "auto_categorize"] }).notNull().default("suggest"),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: uuid("created_by"),
    updatedBy: uuid("updated_by"),
    /** Whether whoever last saved the rule held banking.rules.autopost then. */
    editorMayAutopost: boolean("editor_may_autopost").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique("bank_rules_org_id_uq").on(t.orgId, t.id), index("bank_rules_priority_idx").on(t.orgId, t.priority)],
);

export const bankRuleApplications = pgTable(
  "bank_rule_applications",
  {
    id: id(),
    orgId: orgId(),
    ruleId: uuid("rule_id").notNull(),
    bankTransactionId: uuid("bank_transaction_id").notNull(),
    outcome: text("outcome", { enum: ["suggested", "auto_categorized", "accepted", "undone"] }).notNull(),
    entryId: uuid("entry_id"),
    actorUserId: uuid("actor_user_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("bank_rule_applications_rule_idx").on(t.orgId, t.ruleId, t.createdAt),
    foreignKey({ columns: [t.orgId, t.ruleId], foreignColumns: [bankRules.orgId, bankRules.id] }).onDelete("cascade"),
    foreignKey({ columns: [t.orgId, t.bankTransactionId], foreignColumns: [bankTransactions.orgId, bankTransactions.id] }),
  ],
);

/** An account at a feed provider, and the money account it feeds. */
export const bankFeedAccounts = pgTable(
  "bank_feed_accounts",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id),
    connectionId: uuid("connection_id").notNull(),
    externalAccountId: text("external_account_id").notNull(),
    name: text("name").notNull(),
    institution: text("institution"),
    currency: currencyCode("currency"),
    balance: money("balance"),
    balanceDate: day("balance_date"),
    linkedAccountId: uuid("linked_account_id"),
    lastSyncedAt: ts("last_synced_at"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("bank_feed_accounts_org_id_uq").on(t.orgId, t.id),
    unique("bank_feed_accounts_external_uq").on(t.orgId, t.connectionId, t.externalAccountId),
    uniqueIndex("bank_feed_accounts_one_link").on(t.orgId, t.linkedAccountId).where(sql`${t.linkedAccountId} is not null`),
    foreignKey({ columns: [t.orgId, t.connectionId], foreignColumns: [integrationConnections.orgId, integrationConnections.id] }).onDelete("cascade"),
    foreignKey({ columns: [t.orgId, t.linkedAccountId], foreignColumns: [accounts.orgId, accounts.id] }),
  ],
);

