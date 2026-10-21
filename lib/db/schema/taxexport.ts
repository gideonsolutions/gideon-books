/**
 * The Gideon Tax export layer: how accounts map to tax-return categories
 * (versioned), book-to-tax adjustments (kept here, never posted to the
 * ledger), reviews of the reconciliation, and the export packages produced.
 */
import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, jsonb, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { createdAt, day, id, money, orgId, ts } from "./_columns";
import { organizations } from "./core";
import { accounts } from "./ledger";

export const TAX_RETURN_TYPES = ["1120", "1120S", "1065", "schedule_c", "custom"] as const;
export type TaxReturnType = (typeof TAX_RETURN_TYPES)[number];

/** Categories an organization defines itself (in addition to the built-in catalogs). */
export const taxCustomCategories = pgTable(
  "tax_custom_categories",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id),
    returnType: text("return_type", { enum: TAX_RETURN_TYPES }).notNull(),
    code: text("code").notNull(),
    description: text("description").notNull(),
    kind: text("kind", { enum: ["income", "deduction", "cogs", "nondeductible", "nontaxable", "separately_stated"] }).notNull(),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [unique("tax_custom_categories_org_id_uq").on(t.orgId, t.id), unique("tax_custom_categories_code_uq").on(t.orgId, t.returnType, t.code)],
);

/** One mapping set per return type per organization; its versions hold the mappings. */
export const taxMappingSets = pgTable(
  "tax_mapping_sets",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id),
    returnType: text("return_type", { enum: TAX_RETURN_TYPES }).notNull(),
    /** The built-in catalog's tax year when the set was created. */
    catalogTaxYear: text("catalog_tax_year"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [unique("tax_mapping_sets_org_id_uq").on(t.orgId, t.id), unique("tax_mapping_sets_return_uq").on(t.orgId, t.returnType)],
);

/**
 * A version is editable until an export uses it; then it is locked, and the
 * next change creates a new version, so every export names exactly the
 * mappings it was built from.
 */
export const taxMappingVersions = pgTable(
  "tax_mapping_versions",
  {
    id: id(),
    orgId: orgId(),
    setId: uuid("set_id").notNull(),
    version: integer("version").notNull(),
    lockedAt: ts("locked_at"),
    note: text("note"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("tax_mapping_versions_org_id_uq").on(t.orgId, t.id),
    unique("tax_mapping_versions_set_version_uq").on(t.setId, t.version),
    foreignKey({ columns: [t.orgId, t.setId], foreignColumns: [taxMappingSets.orgId, taxMappingSets.id] }).onDelete("cascade"),
  ],
);

export const taxMappings = pgTable(
  "tax_mappings",
  {
    id: id(),
    orgId: orgId(),
    versionId: uuid("version_id").notNull(),
    accountId: uuid("account_id").notNull(),
    /** Optional: map only this account's lines carrying this dimension value. */
    dimensionKind: text("dimension_kind", { enum: ["project", "class", "department", "location", "fund"] }),
    dimensionValueId: uuid("dimension_value_id"),
    /** dimension kind + value as text ("" for the whole account), for uniqueness. */
    dimensionKey: text("dimension_key").notNull().default(""),
    categoryCode: text("category_code").notNull(),
    /** A suggestion the software made that nobody has confirmed yet. */
    confirmed: boolean("confirmed").notNull().default(false),
    confirmedBy: uuid("confirmed_by"),
    confirmedAt: ts("confirmed_at"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("tax_mappings_cell_uq").on(t.versionId, t.accountId, t.dimensionKey),
    index("tax_mappings_version_idx").on(t.orgId, t.versionId),
    foreignKey({ columns: [t.orgId, t.versionId], foreignColumns: [taxMappingVersions.orgId, taxMappingVersions.id] }).onDelete("cascade"),
    foreignKey({ columns: [t.orgId, t.accountId], foreignColumns: [accounts.orgId, accounts.id] }),
    check("tax_mappings_dimension_pair", sql`(${t.dimensionKind} is null) = (${t.dimensionValueId} is null)`),
  ],
);

/**
 * A book-to-tax adjustment for a tax year. It changes a category's tax
 * amount; it never posts to the ledger. Voided, not deleted.
 */
export const taxAdjustments = pgTable(
  "tax_adjustments",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id),
    returnType: text("return_type", { enum: TAX_RETURN_TYPES }).notNull(),
    taxYearStart: day("tax_year_start").notNull(),
    taxYearEnd: day("tax_year_end").notNull(),
    categoryCode: text("category_code").notNull(),
    kind: text("kind", { enum: ["permanent", "temporary"] }).notNull(),
    /** Added to the category's book amount (in the category's own sign: positive increases it). */
    amount: money("amount").notNull(),
    description: text("description").notNull(),
    source: text("source", { enum: ["manual", "depreciation", "meals_limitation", "other"] }).notNull().default("manual"),
    sourceRef: text("source_ref"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
    voidedAt: ts("voided_at"),
    voidedBy: uuid("voided_by"),
    voidReason: text("void_reason"),
  },
  (t) => [
    unique("tax_adjustments_org_id_uq").on(t.orgId, t.id),
    index("tax_adjustments_year_idx").on(t.orgId, t.returnType, t.taxYearStart),
    check("tax_adjustments_range", sql`${t.taxYearEnd} >= ${t.taxYearStart}`),
  ],
);

/** A person's review or approval of a book-to-tax reconciliation as it stood (its data hash). */
export const taxReviews = pgTable(
  "tax_reviews",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id),
    returnType: text("return_type", { enum: TAX_RETURN_TYPES }).notNull(),
    versionId: uuid("version_id").notNull(),
    taxYearStart: day("tax_year_start").notNull(),
    taxYearEnd: day("tax_year_end").notNull(),
    basis: text("basis", { enum: ["accrual", "cash"] }).notNull(),
    status: text("status", { enum: ["reviewed", "approved"] }).notNull(),
    dataHash: text("data_hash").notNull(),
    note: text("note"),
    reviewedBy: uuid("reviewed_by"),
    reviewedByLabel: text("reviewed_by_label").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("tax_reviews_year_idx").on(t.orgId, t.returnType, t.taxYearStart),
    foreignKey({ columns: [t.orgId, t.versionId], foreignColumns: [taxMappingVersions.orgId, taxMappingVersions.id] }),
  ],
);

/** An export package produced for Gideon Tax: the JSON and CSV are attachments. */
export const taxExports = pgTable(
  "tax_exports",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id),
    returnType: text("return_type", { enum: TAX_RETURN_TYPES }).notNull(),
    versionId: uuid("version_id").notNull(),
    periodStart: day("period_start").notNull(),
    periodEnd: day("period_end").notNull(),
    basis: text("basis", { enum: ["accrual", "cash"] }).notNull(),
    /** SHA-256 of the package without its generation time and author. */
    contentHash: text("content_hash").notNull(),
    sourceHash: text("source_hash").notNull(),
    jsonAttachmentId: uuid("json_attachment_id"),
    csvAttachmentId: uuid("csv_attachment_id"),
    entryCount: integer("entry_count").notNull(),
    lastEntryNumber: integer("last_entry_number"),
    unmappedCount: integer("unmapped_count").notNull().default(0),
    summary: jsonb("summary"),
    generatedBy: uuid("generated_by"),
    generatedByLabel: text("generated_by_label").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("tax_exports_org_id_uq").on(t.orgId, t.id),
    index("tax_exports_org_idx").on(t.orgId, t.createdAt),
    foreignKey({ columns: [t.orgId, t.versionId], foreignColumns: [taxMappingVersions.orgId, taxMappingVersions.id] }),
  ],
);
