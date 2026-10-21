/**
 * The application's navigation: every section and page, with the
 * permission needed to see it. Paths are relative to /o/<org>.
 */
import type { Permission } from "@/lib/authz/permissions";

export interface NavItem {
  label: string;
  href: string;
  permission?: Permission;
}

export interface NavSection {
  label: string;
  icon: string;
  items: NavItem[];
}

export const NAV: NavSection[] = [
  {
    label: "Banking",
    icon: "bank",
    items: [
      { label: "Bank accounts", href: "/banking", permission: "banking.read" },
      { label: "Transactions to review", href: "/banking/transactions", permission: "banking.read" },
      { label: "Imports", href: "/banking/imports", permission: "banking.import" },
      { label: "Reconciliations", href: "/banking/reconciliations", permission: "banking.read" },
      { label: "Rules", href: "/banking/rules", permission: "banking.read" },
    ],
  },
  {
    label: "Sales",
    icon: "sales",
    items: [
      { label: "Invoices", href: "/sales/invoices" },
      { label: "Estimates", href: "/sales/estimates" },
      { label: "Payments received", href: "/sales/payments" },
      { label: "Credit notes", href: "/sales/credit-notes" },
      { label: "Sales receipts", href: "/sales/receipts" },
      { label: "Recurring invoices", href: "/sales/recurring" },
      { label: "Customers", href: "/sales/customers" },
    ],
  },
  {
    label: "Purchases",
    icon: "purchases",
    items: [
      { label: "Bills", href: "/purchases/bills" },
      { label: "Bills due", href: "/purchases/bills/due" },
      { label: "Expenses", href: "/purchases/expenses" },
      { label: "Purchase orders", href: "/purchases/orders" },
      { label: "Payments made", href: "/purchases/payments" },
      { label: "Vendor credits", href: "/purchases/credits" },
      { label: "Receipt inbox", href: "/purchases/receipts" },
      { label: "Recurring bills", href: "/purchases/recurring" },
      { label: "Vendors", href: "/purchases/vendors" },
    ],
  },
  {
    label: "Products & inventory",
    icon: "inventory",
    items: [
      { label: "Products & services", href: "/inventory/items" },
      { label: "Stock on hand", href: "/inventory/stock" },
      { label: "Adjustments & transfers", href: "/inventory/movements" },
      { label: "Inventory valuation", href: "/inventory/valuation" },
      { label: "Locations", href: "/inventory/locations" },
    ],
  },
  {
    label: "Fixed assets",
    icon: "assets",
    items: [
      { label: "Asset register", href: "/assets" },
      { label: "Depreciation runs", href: "/assets/depreciation" },
    ],
  },
  {
    label: "Projects & budgets",
    icon: "projects",
    items: [
      { label: "Projects", href: "/projects" },
      { label: "Time", href: "/projects/time" },
      { label: "Budgets", href: "/budgets" },
    ],
  },
  {
    label: "Payroll",
    icon: "payroll",
    items: [
      { label: "Payroll runs", href: "/payroll" },
      { label: "Import a payroll", href: "/payroll/import", permission: "payroll.import" },
      { label: "Mappings", href: "/payroll/mappings" },
    ],
  },
  {
    label: "Accounting",
    icon: "ledger",
    items: [
      { label: "Chart of accounts", href: "/accounting/accounts" },
      { label: "Journal entries", href: "/accounting/journal" },
      { label: "Opening balances", href: "/accounting/opening-balances" },
      { label: "Periods & close", href: "/accounting/periods" },
      { label: "Dimensions & funds", href: "/accounting/dimensions" },
      { label: "Currencies", href: "/accounting/currencies" },
      { label: "Sales tax", href: "/accounting/sales-tax" },
    ],
  },
  {
    label: "Reports",
    icon: "reports",
    items: [
      { label: "All reports", href: "/reports", permission: "reports.read" },
      { label: "Gideon Tax export", href: "/tax", permission: "reports.read" },
      { label: "Entity groups", href: "/consolidation", permission: "reports.read" },
      { label: "Funds (nonprofit)", href: "/specialized/funds", permission: "reports.read" },
      { label: "Trusts & estates", href: "/specialized/trusts", permission: "reports.read" },
    ],
  },
  {
    label: "Settings",
    icon: "settings",
    items: [
      { label: "Organization", href: "/settings" },
      { label: "Members & access", href: "/settings/members" },
      { label: "Invoice branding", href: "/settings/branding", permission: "org.settings" },
      { label: "Integrations", href: "/settings/integrations" },
      { label: "Email", href: "/settings/email" },
      { label: "Data export & backup", href: "/settings/data" },
      { label: "Plan & usage", href: "/settings/billing" },
      { label: "API tokens", href: "/settings/api", permission: "api_tokens.manage" },
      { label: "Audit log", href: "/audit", permission: "audit.read" },
      { label: "Background jobs", href: "/jobs", permission: "jobs.read" },
    ],
  },
];
