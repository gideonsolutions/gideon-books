/**
 * Budgets: amounts per account per month of a fiscal year, optionally for
 * one dimension value (a project, class, department, location or fund).
 */
import { sql } from "drizzle-orm";
import { check, foreignKey, index, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { createdAt, day, id, money, orgId, updatedAt } from "./_columns";
import { organizations } from "./core";
import { accounts, dimensionValues, projects } from "./ledger";

export const BUDGET_DIMENSIONS = ["project", "class", "department", "location", "fund"] as const;
export type BudgetDimension = (typeof BUDGET_DIMENSIONS)[number];

export const budgets = pgTable(
  "budgets",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id),
    name: text("name").notNull(),
    /** First day of the fiscal year the budget covers (twelve months from here). */
    fiscalYearStart: day("fiscal_year_start").notNull(),
    /** When set, budget lines are entered per value of this dimension. */
    dimension: text("dimension", { enum: BUDGET_DIMENSIONS }),
    status: text("status", { enum: ["draft", "active", "archived"] }).notNull().default("active"),
    notes: text("notes"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique("budgets_org_id_uq").on(t.orgId, t.id), unique("budgets_org_name_uq").on(t.orgId, t.name)],
);

export const budgetLines = pgTable(
  "budget_lines",
  {
    id: id(),
    orgId: orgId(),
    budgetId: uuid("budget_id").notNull(),
    accountId: uuid("account_id").notNull(),
    /** The project (when the budget's dimension is "project"). */
    projectId: uuid("project_id"),
    /** The class, department, location or fund (for those dimensions). */
    dimensionValueId: uuid("dimension_value_id"),
    /** The dimension value as text ("" when none), for uniqueness. */
    dimensionKey: text("dimension_key").notNull().default(""),
    /** First day of the month. */
    periodStart: day("period_start").notNull(),
    /** Signed the natural way for the account: income and expense budgets are positive. */
    amount: money("amount").notNull(),
  },
  (t) => [
    unique("budget_lines_cell_uq").on(t.budgetId, t.accountId, t.dimensionKey, t.periodStart),
    index("budget_lines_budget_idx").on(t.orgId, t.budgetId),
    foreignKey({ columns: [t.orgId, t.budgetId], foreignColumns: [budgets.orgId, budgets.id] }).onDelete("cascade"),
    foreignKey({ columns: [t.orgId, t.accountId], foreignColumns: [accounts.orgId, accounts.id] }),
    foreignKey({ columns: [t.orgId, t.projectId], foreignColumns: [projects.orgId, projects.id] }),
    foreignKey({ columns: [t.orgId, t.dimensionValueId], foreignColumns: [dimensionValues.orgId, dimensionValues.id] }),
    check("budget_lines_month_start", sql`extract(day from ${t.periodStart}) = 1`),
  ],
);
