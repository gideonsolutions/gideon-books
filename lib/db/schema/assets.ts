/**
 * Fixed assets: the register, depreciation runs (each asset-month is
 * depreciated once), disposals, and the separate tax book (which never posts
 * to the ledger). See docs/accounting/fixed-assets.md.
 */
import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, pgTable, primaryKey, text, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, day, id, money, orgId, rate, ts, updatedAt } from "./_columns";
import { organizations } from "./core";
import { accounts, dimensionValues, journalEntries, projects } from "./ledger";
import { documentLines, documents } from "./commerce";

export const DEPRECIATION_METHODS = ["straight_line", "declining_balance", "none"] as const;
export type DepreciationMethod = (typeof DEPRECIATION_METHODS)[number];

export const fixedAssets = pgTable(
  "fixed_assets",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id),
    /** FA-0001, from the "asset" sequence. */
    number: text("number").notNull(),
    name: text("name").notNull(),
    category: text("category"),
    description: text("description"),
    assetAccountId: uuid("asset_account_id").notNull(),
    accumulatedDepreciationAccountId: uuid("accumulated_depreciation_account_id").notNull(),
    depreciationExpenseAccountId: uuid("depreciation_expense_account_id").notNull(),
    acquisitionDate: day("acquisition_date").notNull(),
    inServiceDate: day("in_service_date").notNull(),
    cost: money("cost").notNull(),
    residualValue: money("residual_value").notNull().default("0"),
    usefulLifeMonths: integer("useful_life_months").notNull(),
    method: text("method", { enum: DEPRECIATION_METHODS }).notNull(),
    /** Declining balance: the multiple of the straight-line rate (2.0 = double declining). */
    decliningFactor: rate("declining_factor"),
    status: text("status", { enum: ["draft", "active", "fully_depreciated", "disposed"] }).notNull().default("draft"),
    /** How the cost reached the ledger. */
    acquisitionType: text("acquisition_type", { enum: ["document_line", "direct", "opening"] }).notNull(),
    /** document_line: the bill or expense line that debited the asset account. */
    sourceDocumentId: uuid("source_document_id"),
    sourceDocumentLineId: uuid("source_document_line_id"),
    /** direct: the account credited (bank, card, loan). */
    fundingAccountId: uuid("funding_account_id"),
    /** direct and opening: the entry that put the cost on the books. */
    acquisitionEntryId: uuid("acquisition_entry_id"),
    /** The ledger date the cost was recorded (for the rollforward). */
    capitalizedOn: day("capitalized_on"),
    /** opening: depreciation already taken before the books started, and the month-end it runs through. */
    openingAccumulatedDepreciation: money("opening_accumulated_depreciation").notNull().default("0"),
    openingDepreciationThrough: day("opening_depreciation_through"),
    classId: uuid("class_id"),
    departmentId: uuid("department_id"),
    locationId: uuid("location_id"),
    projectId: uuid("project_id"),
    notes: text("notes"),
    disposedOn: day("disposed_on"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("fixed_assets_org_id_uq").on(t.orgId, t.id),
    unique("fixed_assets_org_number_uq").on(t.orgId, t.number),
    uniqueIndex("fixed_assets_source_line_uq").on(t.orgId, t.sourceDocumentLineId).where(sql`${t.sourceDocumentLineId} is not null and ${t.status} <> 'draft'`),
    index("fixed_assets_org_status_idx").on(t.orgId, t.status),
    foreignKey({ columns: [t.orgId, t.assetAccountId], foreignColumns: [accounts.orgId, accounts.id] }),
    foreignKey({ columns: [t.orgId, t.accumulatedDepreciationAccountId], foreignColumns: [accounts.orgId, accounts.id] }),
    foreignKey({ columns: [t.orgId, t.depreciationExpenseAccountId], foreignColumns: [accounts.orgId, accounts.id] }),
    foreignKey({ columns: [t.orgId, t.fundingAccountId], foreignColumns: [accounts.orgId, accounts.id] }),
    foreignKey({ columns: [t.orgId, t.sourceDocumentId], foreignColumns: [documents.orgId, documents.id] }),
    foreignKey({ columns: [t.orgId, t.sourceDocumentLineId], foreignColumns: [documentLines.orgId, documentLines.id] }),
    foreignKey({ columns: [t.orgId, t.acquisitionEntryId], foreignColumns: [journalEntries.orgId, journalEntries.id] }),
    foreignKey({ columns: [t.orgId, t.classId], foreignColumns: [dimensionValues.orgId, dimensionValues.id] }),
    foreignKey({ columns: [t.orgId, t.departmentId], foreignColumns: [dimensionValues.orgId, dimensionValues.id] }),
    foreignKey({ columns: [t.orgId, t.locationId], foreignColumns: [dimensionValues.orgId, dimensionValues.id] }),
    foreignKey({ columns: [t.orgId, t.projectId], foreignColumns: [projects.orgId, projects.id] }),
    check("fixed_assets_cost_nonnegative", sql`${t.cost} >= 0 and ${t.residualValue} >= 0 and ${t.residualValue} <= ${t.cost}`),
    check("fixed_assets_life", sql`${t.usefulLifeMonths} between 1 and 1200`),
    check("fixed_assets_in_service", sql`${t.inServiceDate} >= ${t.acquisitionDate}`),
  ],
);

/**
 * A depreciation run: the depreciation for a period end, prepared for review
 * and then posted as one entry. Catch-up months for an asset that missed a
 * run are included with their own month.
 */
export const depreciationRuns = pgTable(
  "depreciation_runs",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id),
    periodEnd: day("period_end").notNull(),
    status: text("status", { enum: ["draft", "posted", "reversed"] }).notNull().default("draft"),
    total: money("total").notNull().default("0"),
    journalEntryId: uuid("journal_entry_id"),
    reversalEntryId: uuid("reversal_entry_id"),
    reversalReason: text("reversal_reason"),
    preparedBy: uuid("prepared_by"),
    preparedByLabel: text("prepared_by_label"),
    postedBy: uuid("posted_by"),
    postedAt: ts("posted_at"),
    reversedAt: ts("reversed_at"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("depreciation_runs_org_id_uq").on(t.orgId, t.id),
    index("depreciation_runs_org_period_idx").on(t.orgId, t.periodEnd),
    foreignKey({ columns: [t.orgId, t.journalEntryId], foreignColumns: [journalEntries.orgId, journalEntries.id] }),
    foreignKey({ columns: [t.orgId, t.reversalEntryId], foreignColumns: [journalEntries.orgId, journalEntries.id] }),
  ],
);

/** One asset-month in a run. An asset-month is held by at most one draft or posted line. */
export const depreciationRunLines = pgTable(
  "depreciation_run_lines",
  {
    id: id(),
    orgId: orgId(),
    runId: uuid("run_id").notNull(),
    assetId: uuid("asset_id").notNull(),
    /** The month-end the depreciation is for. */
    periodEnd: day("period_end").notNull(),
    amount: money("amount").notNull(),
    status: text("status", { enum: ["draft", "posted", "reversed"] }).notNull().default("draft"),
  },
  (t) => [
    unique("depreciation_run_lines_org_id_uq").on(t.orgId, t.id),
    uniqueIndex("depreciation_once_per_asset_month").on(t.orgId, t.assetId, t.periodEnd).where(sql`${t.status} <> 'reversed'`),
    index("depreciation_run_lines_run_idx").on(t.runId),
    foreignKey({ columns: [t.orgId, t.runId], foreignColumns: [depreciationRuns.orgId, depreciationRuns.id] }).onDelete("cascade"),
    foreignKey({ columns: [t.orgId, t.assetId], foreignColumns: [fixedAssets.orgId, fixedAssets.id] }),
    check("depreciation_run_lines_positive", sql`${t.amount} > 0`),
  ],
);

export const assetDisposals = pgTable(
  "asset_disposals",
  {
    id: id(),
    orgId: orgId(),
    assetId: uuid("asset_id").notNull(),
    disposalDate: day("disposal_date").notNull(),
    proceeds: money("proceeds").notNull().default("0"),
    proceedsAccountId: uuid("proceeds_account_id"),
    costRemoved: money("cost_removed").notNull(),
    accumulatedRemoved: money("accumulated_removed").notNull(),
    /** Positive gain, negative loss. */
    gainLoss: money("gain_loss").notNull(),
    reason: text("reason"),
    status: text("status", { enum: ["posted", "reversed"] }).notNull().default("posted"),
    journalEntryId: uuid("journal_entry_id"),
    reversalEntryId: uuid("reversal_entry_id"),
    reversalReason: text("reversal_reason"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("asset_disposals_org_id_uq").on(t.orgId, t.id),
    uniqueIndex("asset_disposals_one_active").on(t.orgId, t.assetId).where(sql`${t.status} = 'posted'`),
    foreignKey({ columns: [t.orgId, t.assetId], foreignColumns: [fixedAssets.orgId, fixedAssets.id] }),
    foreignKey({ columns: [t.orgId, t.proceedsAccountId], foreignColumns: [accounts.orgId, accounts.id] }),
    foreignKey({ columns: [t.orgId, t.journalEntryId], foreignColumns: [journalEntries.orgId, journalEntries.id] }),
    foreignKey({ columns: [t.orgId, t.reversalEntryId], foreignColumns: [journalEntries.orgId, journalEntries.id] }),
  ],
);

/**
 * The tax book: how the asset is depreciated for income tax, kept apart from
 * the books. The method label (e.g. "MACRS 5-year, half-year") is the
 * person's record of what they use; amounts are either computed by a simple
 * method here or entered per tax year. Nothing here posts to the ledger.
 */
export const assetTaxBooks = pgTable(
  "asset_tax_books",
  {
    orgId: orgId(),
    assetId: uuid("asset_id").notNull(),
    method: text("method", { enum: ["straight_line", "declining_balance", "entered"] }).notNull(),
    methodLabel: text("method_label"),
    taxBasis: money("tax_basis").notNull(),
    usefulLifeMonths: integer("useful_life_months"),
    decliningFactor: rate("declining_factor"),
    placedInService: day("placed_in_service").notNull(),
    notes: text("notes"),
    updatedBy: uuid("updated_by"),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.assetId] }),
    foreignKey({ columns: [t.orgId, t.assetId], foreignColumns: [fixedAssets.orgId, fixedAssets.id] }).onDelete("cascade"),
  ],
);

/** Tax depreciation entered per tax year (method "entered"). */
export const assetTaxDepreciation = pgTable(
  "asset_tax_depreciation",
  {
    id: id(),
    orgId: orgId(),
    assetId: uuid("asset_id").notNull(),
    taxYearStart: day("tax_year_start").notNull(),
    taxYearEnd: day("tax_year_end").notNull(),
    amount: money("amount").notNull(),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("asset_tax_depreciation_year_uq").on(t.orgId, t.assetId, t.taxYearStart),
    foreignKey({ columns: [t.orgId, t.assetId], foreignColumns: [fixedAssets.orgId, fixedAssets.id] }).onDelete("cascade"),
    check("asset_tax_depreciation_nonnegative", sql`${t.amount} >= 0`),
  ],
);

/** Per-organization settings for the assets module. */
export const assetSettings = pgTable("asset_settings", {
  orgId: uuid("org_id")
    .primaryKey()
    .references(() => organizations.id),
  /** Post the monthly depreciation run automatically instead of leaving it for review. Off by default. */
  autoPostDepreciation: boolean("auto_post_depreciation").notNull().default(false),
  updatedAt: updatedAt(),
});
