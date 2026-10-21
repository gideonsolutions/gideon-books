/**
 * Roles and what each may do. Checked on the server in every service
 * function (lib/context.ts → requirePermission), never only in the UI.
 *
 *  owner       everything, including members, billing and deleting the organization
 *  admin       everything but ownership, billing and deletion
 *  accountant  all accounting: post, reverse, close and reopen periods, reconcile, tax, export
 *  staff       day-to-day: contacts, items, documents, payments, bank review; no closing, no settings
 *  read_only   reads everything, changes nothing
 */
import type { Role } from "@/lib/db/schema/core";

export const PERMISSIONS = [
  "org.read",
  "org.settings",
  "org.delete",
  "members.manage",
  "billing.manage",
  "api_tokens.manage",
  "integrations.manage",
  "audit.read",
  "accounts.manage",
  "ledger.read",
  "ledger.draft",
  "ledger.post",
  "ledger.reverse",
  "periods.close",
  "periods.reopen",
  "opening_balances.manage",
  "contacts.manage",
  "items.manage",
  "sales.manage",
  "sales.issue",
  "sales.void",
  "purchases.manage",
  "purchases.approve",
  "purchases.void",
  "payments.record",
  "payments.void",
  "banking.read",
  "banking.import",
  "banking.categorize",
  "banking.reconcile",
  "banking.reconcile.reopen",
  "banking.rules.manage",
  "banking.rules.autopost",
  "inventory.manage",
  "assets.manage",
  "assets.depreciate",
  "projects.manage",
  "time.record",
  "budgets.manage",
  "fx.manage",
  "sales_tax.manage",
  "payroll.import",
  "consolidation.manage",
  "tax_export.manage",
  "reports.read",
  "data.export",
  "data.import",
  "jobs.read",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const READ: Permission[] = ["org.read", "ledger.read", "banking.read", "reports.read", "jobs.read"];

const STAFF: Permission[] = [
  ...READ,
  "ledger.draft",
  "contacts.manage",
  "items.manage",
  "sales.manage",
  "sales.issue",
  "purchases.manage",
  "payments.record",
  "banking.import",
  "banking.categorize",
  "inventory.manage",
  "projects.manage",
  "time.record",
];

const ACCOUNTANT: Permission[] = [
  ...STAFF,
  "audit.read",
  "accounts.manage",
  "ledger.post",
  "ledger.reverse",
  "periods.close",
  "periods.reopen",
  "opening_balances.manage",
  "sales.void",
  "purchases.approve",
  "purchases.void",
  "payments.void",
  "banking.reconcile",
  "banking.reconcile.reopen",
  "banking.rules.manage",
  "banking.rules.autopost",
  "assets.manage",
  "assets.depreciate",
  "budgets.manage",
  "fx.manage",
  "sales_tax.manage",
  "payroll.import",
  "consolidation.manage",
  "tax_export.manage",
  "data.export",
];

const ADMIN: Permission[] = [
  ...ACCOUNTANT,
  "org.settings",
  "members.manage",
  "api_tokens.manage",
  "integrations.manage",
  "data.import",
];

const OWNER: Permission[] = [...ADMIN, "billing.manage", "org.delete"];

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  owner: new Set(OWNER),
  admin: new Set(ADMIN),
  accountant: new Set(ACCOUNTANT),
  staff: new Set(STAFF),
  read_only: new Set(READ),
};

export const ROLE_RANK: Record<Role, number> = { owner: 5, admin: 4, accountant: 3, staff: 2, read_only: 1 };

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  admin: "Administrator",
  accountant: "Accountant",
  staff: "Staff",
  read_only: "Read-only",
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  owner: "Everything, including members, billing and deleting the organization.",
  admin: "Everything except billing and deleting the organization.",
  accountant: "All accounting: posting, reversing, closing periods, reconciling, tax and exports.",
  staff: "Day-to-day work: customers, vendors, invoices, bills, payments and bank review.",
  read_only: "Can see everything and change nothing.",
};

export function roleHas(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

/** Whether `actor` may grant `target` (no one grants a role above their own; only owners make owners). */
export function canGrantRole(actor: Role, target: Role): boolean {
  if (target === "owner") return actor === "owner";
  return ROLE_RANK[actor] >= ROLE_RANK[target] && roleHas(actor, "members.manage");
}
