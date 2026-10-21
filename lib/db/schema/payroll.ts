/**
 * Payroll integration: what a payroll provider calculated is imported,
 * checked, mapped to accounts and posted. Gideon Books does not calculate
 * payroll taxes or file payroll returns. See docs/payroll.md.
 */
import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, jsonb, pgTable, text, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, day, id, money, orgId, ts, updatedAt } from "./_columns";
import { organizations } from "./core";
import { accounts, contacts, dimensionValues, journalEntries, projects } from "./ledger";

export const PAYROLL_COMPONENT_TYPES = [
  "gross_wages",
  "employee_withholding",
  "employee_deduction",
  "employer_tax",
  "employer_benefit",
  "reimbursement",
  "net_pay",
] as const;
export type PayrollComponentType = (typeof PAYROLL_COMPONENT_TYPES)[number];

/**
 * Where each payroll component posts. `component_code` "*" is the default for
 * its type, used for any code without its own mapping.
 */
export const payrollMappings = pgTable(
  "payroll_mappings",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id),
    componentType: text("component_type", { enum: PAYROLL_COMPONENT_TYPES }).notNull(),
    componentCode: text("component_code").notNull(),
    label: text("label"),
    /** The debit side: wages, employer taxes and benefits, reimbursements. */
    expenseAccountId: uuid("expense_account_id"),
    /** The credit side: withholdings, deductions and employer amounts owed; net pay. */
    liabilityAccountId: uuid("liability_account_id"),
    updatedBy: uuid("updated_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("payroll_mappings_org_id_uq").on(t.orgId, t.id),
    unique("payroll_mappings_component_uq").on(t.orgId, t.componentType, t.componentCode),
    foreignKey({ columns: [t.orgId, t.expenseAccountId], foreignColumns: [accounts.orgId, accounts.id] }),
    foreignKey({ columns: [t.orgId, t.liabilityAccountId], foreignColumns: [accounts.orgId, accounts.id] }),
  ],
);

/** An uploaded payroll file, parsed and checked, waiting to be posted (or posted). */
export const payrollImports = pgTable(
  "payroll_imports",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id),
    adapter: text("adapter").notNull(),
    fileName: text("file_name").notNull(),
    fileSha256: text("file_sha256").notNull(),
    rawContent: text("raw_content").notNull(),
    status: text("status", { enum: ["previewed", "posted", "discarded"] }).notNull().default("previewed"),
    /** The parsed run (normalized), so posting uses exactly what was previewed. */
    parsed: jsonb("parsed"),
    errors: jsonb("errors").$type<string[]>().notNull().default([]),
    runId: uuid("run_id"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [unique("payroll_imports_org_id_uq").on(t.orgId, t.id), index("payroll_imports_org_idx").on(t.orgId, t.createdAt)],
);

export const payrollRuns = pgTable(
  "payroll_runs",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id),
    /** Who calculated it: generic_csv, generic_json, or a provider adapter. */
    provider: text("provider").notNull(),
    providerRunId: text("provider_run_id").notNull(),
    payDate: day("pay_date").notNull(),
    periodStart: day("period_start").notNull(),
    periodEnd: day("period_end").notNull(),
    status: text("status", { enum: ["posted", "void"] }).notNull().default("posted"),
    fileName: text("file_name"),
    fileSha256: text("file_sha256"),
    importId: uuid("import_id"),
    employeeCount: integer("employee_count").notNull().default(0),
    grossWages: money("gross_wages").notNull().default("0"),
    employeeWithholdings: money("employee_withholdings").notNull().default("0"),
    employeeDeductions: money("employee_deductions").notNull().default("0"),
    employerTaxes: money("employer_taxes").notNull().default("0"),
    employerBenefits: money("employer_benefits").notNull().default("0"),
    reimbursements: money("reimbursements").notNull().default("0"),
    netPay: money("net_pay").notNull().default("0"),
    /** A correction run adjusting an earlier one. */
    isAdjustment: boolean("is_adjustment").notNull().default(false),
    adjustsRunId: uuid("adjusts_run_id"),
    /** The mappings as they were when posted (provenance). */
    mappingSnapshot: jsonb("mapping_snapshot"),
    journalEntryId: uuid("journal_entry_id"),
    voidEntryId: uuid("void_entry_id"),
    voidReason: text("void_reason"),
    voidedAt: ts("voided_at"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("payroll_runs_org_id_uq").on(t.orgId, t.id),
    uniqueIndex("payroll_runs_provider_run_uq").on(t.orgId, t.provider, t.providerRunId).where(sql`${t.status} <> 'void'`),
    uniqueIndex("payroll_runs_file_uq").on(t.orgId, t.fileSha256).where(sql`${t.status} <> 'void' and ${t.fileSha256} is not null`),
    index("payroll_runs_org_date_idx").on(t.orgId, t.payDate),
    foreignKey({ columns: [t.orgId, t.journalEntryId], foreignColumns: [journalEntries.orgId, journalEntries.id] }),
    foreignKey({ columns: [t.orgId, t.voidEntryId], foreignColumns: [journalEntries.orgId, journalEntries.id] }),
    foreignKey({ columns: [t.orgId, t.adjustsRunId], foreignColumns: [t.orgId, t.id] }),
  ],
);

/** The imported detail: one row per employee per component (or per component for summary imports). */
export const payrollRunLines = pgTable(
  "payroll_run_lines",
  {
    id: id(),
    orgId: orgId(),
    runId: uuid("run_id").notNull(),
    employeeRef: text("employee_ref"),
    employeeName: text("employee_name"),
    contactId: uuid("contact_id"),
    componentType: text("component_type", { enum: PAYROLL_COMPONENT_TYPES }).notNull(),
    componentCode: text("component_code").notNull(),
    amount: money("amount").notNull(),
    departmentId: uuid("department_id"),
    classId: uuid("class_id"),
    locationId: uuid("location_id"),
    projectId: uuid("project_id"),
  },
  (t) => [
    index("payroll_run_lines_run_idx").on(t.runId),
    foreignKey({ columns: [t.orgId, t.runId], foreignColumns: [payrollRuns.orgId, payrollRuns.id] }).onDelete("cascade"),
    foreignKey({ columns: [t.orgId, t.contactId], foreignColumns: [contacts.orgId, contacts.id] }),
    foreignKey({ columns: [t.orgId, t.departmentId], foreignColumns: [dimensionValues.orgId, dimensionValues.id] }),
    foreignKey({ columns: [t.orgId, t.classId], foreignColumns: [dimensionValues.orgId, dimensionValues.id] }),
    foreignKey({ columns: [t.orgId, t.locationId], foreignColumns: [dimensionValues.orgId, dimensionValues.id] }),
    foreignKey({ columns: [t.orgId, t.projectId], foreignColumns: [projects.orgId, projects.id] }),
  ],
);

/**
 * Cash settlement of a run: the net pay disbursed, and payments of payroll
 * liabilities (tax deposits, benefit remittances). Recorded, never initiated.
 */
export const payrollSettlements = pgTable(
  "payroll_settlements",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id),
    runId: uuid("run_id"),
    kind: text("kind", { enum: ["net_pay", "liability"] }).notNull(),
    settlementDate: day("settlement_date").notNull(),
    bankAccountId: uuid("bank_account_id").notNull(),
    /** The clearing or liability account debited. */
    liabilityAccountId: uuid("liability_account_id").notNull(),
    amount: money("amount").notNull(),
    reference: text("reference"),
    memo: text("memo"),
    status: text("status", { enum: ["posted", "void"] }).notNull().default("posted"),
    journalEntryId: uuid("journal_entry_id"),
    voidEntryId: uuid("void_entry_id"),
    voidReason: text("void_reason"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("payroll_settlements_org_id_uq").on(t.orgId, t.id),
    index("payroll_settlements_run_idx").on(t.orgId, t.runId),
    foreignKey({ columns: [t.orgId, t.runId], foreignColumns: [payrollRuns.orgId, payrollRuns.id] }),
    foreignKey({ columns: [t.orgId, t.bankAccountId], foreignColumns: [accounts.orgId, accounts.id] }),
    foreignKey({ columns: [t.orgId, t.liabilityAccountId], foreignColumns: [accounts.orgId, accounts.id] }),
    foreignKey({ columns: [t.orgId, t.journalEntryId], foreignColumns: [journalEntries.orgId, journalEntries.id] }),
    foreignKey({ columns: [t.orgId, t.voidEntryId], foreignColumns: [journalEntries.orgId, journalEntries.id] }),
    check("payroll_settlements_positive", sql`${t.amount} > 0`),
  ],
);
