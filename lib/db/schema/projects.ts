/**
 * Projects and time: time entries, and the links that record which time and
 * which billable expenses were billed on which invoice (so nothing is billed
 * twice). The projects table itself is in the ledger schema.
 */
import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, numeric, pgTable, text, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, day, id, money, orgId, unitAmount, updatedAt } from "./_columns";
import { organizations, users } from "./core";
import { contacts, projects } from "./ledger";
import { documents } from "./commerce";

export const timeEntries = pgTable(
  "time_entries",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id),
    projectId: uuid("project_id").notNull(),
    workDate: day("work_date").notNull(),
    /** Who did the work: a member of the organization, or an employee contact. */
    userId: uuid("user_id").references(() => users.id),
    contactId: uuid("contact_id"),
    personLabel: text("person_label").notNull(),
    hours: numeric("hours", { precision: 8, scale: 2 }).notNull(),
    /** Billing rate per hour in the project's customer currency; null uses the project rate. */
    rate: unitAmount("rate"),
    billable: boolean("billable").notNull().default(true),
    description: text("description").notNull().default(""),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("time_entries_org_id_uq").on(t.orgId, t.id),
    index("time_entries_project_idx").on(t.orgId, t.projectId, t.workDate),
    foreignKey({ columns: [t.orgId, t.projectId], foreignColumns: [projects.orgId, projects.id] }),
    foreignKey({ columns: [t.orgId, t.contactId], foreignColumns: [contacts.orgId, contacts.id] }),
    check("time_entries_hours", sql`${t.hours} > 0 and ${t.hours} <= 24`),
  ],
);

/**
 * Time or a billable expense line billed on an invoice. Deleting the draft
 * invoice deletes its links; a void invoice's links are released when the
 * work is billed again.
 */
export const projectBillingLinks = pgTable(
  "project_billing_links",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id),
    invoiceId: uuid("invoice_id").notNull(),
    projectId: uuid("project_id"),
    sourceType: text("source_type", { enum: ["time_entry", "expense_line"] }).notNull(),
    /** The time entry id, or the purchase document line id. */
    sourceId: uuid("source_id").notNull(),
    amount: money("amount").notNull(),
    status: text("status", { enum: ["active", "released"] }).notNull().default("active"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("project_billing_once").on(t.orgId, t.sourceType, t.sourceId).where(sql`${t.status} = 'active'`),
    index("project_billing_invoice_idx").on(t.orgId, t.invoiceId),
    foreignKey({ columns: [t.orgId, t.invoiceId], foreignColumns: [documents.orgId, documents.id] }).onDelete("cascade"),
    foreignKey({ columns: [t.orgId, t.projectId], foreignColumns: [projects.orgId, projects.id] }),
  ],
);
