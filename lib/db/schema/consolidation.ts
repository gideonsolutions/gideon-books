/**
 * Entity groups for consolidated reporting. A group is not an organization:
 * it belongs to the person who created it and spans the organizations that
 * are its members. Nothing here posts to a member's books — eliminations and
 * translation live at group level only (docs/consolidation.md).
 */
import { sql } from "drizzle-orm";
import { bigserial, boolean, check, foreignKey, index, jsonb, pgTable, primaryKey, text, unique, uuid } from "drizzle-orm/pg-core";
import { createdAt, currencyCode, day, fxRate, id, money, rate, ts } from "./_columns";
import { organizations, users } from "./core";
import { accounts } from "./ledger";

export const entityGroups = pgTable("entity_groups", {
  id: id(),
  name: text("name").notNull(),
  /** The currency consolidated statements are presented in. */
  reportingCurrency: currencyCode("reporting_currency").notNull(),
  /** Demo groups hold only demonstration organizations; real groups only real ones. */
  isDemo: boolean("is_demo").notNull().default(false),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: createdAt(),
  archivedAt: ts("archived_at"),
});

export const entityGroupMembers = pgTable(
  "entity_group_members",
  {
    groupId: uuid("group_id")
      .notNull()
      .references(() => entityGroups.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Ownership as a fraction (1 = 100%). Consolidation is full; the share is recorded for presentation. */
    ownership: rate("ownership").notNull().default("1"),
    method: text("method", { enum: ["full"] }).notNull().default("full"),
    addedBy: uuid("added_by"),
    addedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.orgId] }), check("group_member_ownership", sql`${t.ownership} > 0 and ${t.ownership} <= 1`)],
);

export const GROUP_ACCOUNT_ROLES = ["retained_earnings", "cta"] as const;

/** The group's own chart: member accounts map onto these. */
export const groupAccounts = pgTable(
  "group_accounts",
  {
    id: id(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => entityGroups.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    type: text("type", { enum: ["asset", "liability", "equity", "income", "expense"] }).notNull(),
    /** Accounts the consolidation itself posts to: prior-period earnings and the translation adjustment. */
    role: text("role", { enum: GROUP_ACCOUNT_ROLES }),
    createdAt: createdAt(),
  },
  (t) => [unique("group_accounts_code_uq").on(t.groupId, t.code), unique("group_accounts_group_id_uq").on(t.groupId, t.id)],
);

/** Member account → group account. Every member account with a balance must be mapped. */
export const groupAccountMappings = pgTable(
  "group_account_mappings",
  {
    groupId: uuid("group_id").notNull(),
    orgId: uuid("org_id").notNull(),
    accountId: uuid("account_id").notNull(),
    groupAccountId: uuid("group_account_id").notNull(),
    updatedBy: uuid("updated_by"),
    updatedAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.accountId] }),
    foreignKey({ columns: [t.groupId, t.orgId], foreignColumns: [entityGroupMembers.groupId, entityGroupMembers.orgId] }).onDelete("cascade"),
    foreignKey({ columns: [t.orgId, t.accountId], foreignColumns: [accounts.orgId, accounts.id] }).onDelete("cascade"),
    foreignKey({ columns: [t.groupId, t.groupAccountId], foreignColumns: [groupAccounts.groupId, groupAccounts.id] }).onDelete("cascade"),
  ],
);

/** Two member accounts that should mirror each other (a receivable in one, the payable in the other). */
export const intercompanyPairs = pgTable(
  "intercompany_pairs",
  {
    id: id(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => entityGroups.id, { onDelete: "cascade" }),
    orgA: uuid("org_a").notNull(),
    accountA: uuid("account_a").notNull(),
    orgB: uuid("org_b").notNull(),
    accountB: uuid("account_b").notNull(),
    description: text("description"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ columns: [t.groupId, t.orgA], foreignColumns: [entityGroupMembers.groupId, entityGroupMembers.orgId] }).onDelete("cascade"),
    foreignKey({ columns: [t.groupId, t.orgB], foreignColumns: [entityGroupMembers.groupId, entityGroupMembers.orgId] }).onDelete("cascade"),
    foreignKey({ columns: [t.orgA, t.accountA], foreignColumns: [accounts.orgId, accounts.id] }).onDelete("cascade"),
    foreignKey({ columns: [t.orgB, t.accountB], foreignColumns: [accounts.orgId, accounts.id] }).onDelete("cascade"),
    check("intercompany_distinct_orgs", sql`${t.orgA} <> ${t.orgB}`),
  ],
);

/** Translation rates entered for the group: reporting-currency units per one unit of `currency`. */
export const groupRates = pgTable(
  "group_rates",
  {
    id: id(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => entityGroups.id, { onDelete: "cascade" }),
    currency: currencyCode("currency").notNull(),
    rateDate: day("rate_date").notNull(),
    rate: fxRate("rate").notNull(),
    note: text("note"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [unique("group_rates_uq").on(t.groupId, t.currency, t.rateDate), check("group_rates_positive", sql`${t.rate} > 0`)],
);

/**
 * An elimination at group level, in the reporting currency. Never edited:
 * a wrong one is voided (with a reason) and replaced.
 */
export const eliminationEntries = pgTable(
  "elimination_entries",
  {
    id: id(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => entityGroups.id, { onDelete: "cascade" }),
    entryDate: day("entry_date").notNull(),
    description: text("description").notNull(),
    source: text("source", { enum: ["manual", "suggested"] }).notNull().default("manual"),
    status: text("status", { enum: ["active", "void"] }).notNull().default("active"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
    voidedAt: ts("voided_at"),
    voidedBy: uuid("voided_by"),
    voidReason: text("void_reason"),
  },
  (t) => [unique("elimination_entries_group_id_uq").on(t.groupId, t.id), index("elimination_entries_group_idx").on(t.groupId, t.entryDate)],
);

export const eliminationLines = pgTable(
  "elimination_lines",
  {
    id: id(),
    groupId: uuid("group_id").notNull(),
    entryId: uuid("entry_id").notNull(),
    groupAccountId: uuid("group_account_id").notNull(),
    /** Signed, reporting currency: debit positive. */
    amount: money("amount").notNull(),
    /** The member the line relates to, for presentation. */
    orgId: uuid("org_id"),
    description: text("description"),
  },
  (t) => [
    foreignKey({ columns: [t.groupId, t.entryId], foreignColumns: [eliminationEntries.groupId, eliminationEntries.id] }).onDelete("cascade"),
    foreignKey({ columns: [t.groupId, t.groupAccountId], foreignColumns: [groupAccounts.groupId, groupAccounts.id] }),
  ],
);

/** The group's own audit trail (groups belong to no organization). Append-only. */
export const groupAuditEvents = pgTable(
  "group_audit_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => entityGroups.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id"),
    actorLabel: text("actor_label").notNull(),
    action: text("action").notNull(),
    reason: text("reason"),
    metadata: jsonb("metadata"),
    createdAt: createdAt(),
  },
  (t) => [index("group_audit_group_idx").on(t.groupId, t.createdAt)],
);
