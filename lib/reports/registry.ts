/**
 * Every report: what it is, what controls it takes, and how to build its
 * table from URL parameters. The report pages and the CSV/PDF export route
 * both go through `buildReport`, so they produce the same thing.
 */
import { and, asc, eq } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import type { Org } from "@/lib/context";
import { dimensionValues, projects } from "@/lib/db/schema/ledger";
import { budgetVsActual } from "@/lib/budgets/budgets";
import { balanceSheet, cashFlow, profitAndLoss, trialBalance, type Comparison, type Dimension } from "./statements";
import { generalLedger } from "./gl";
import { aging, contactBalances } from "./aging";
import { salesTaxLiability } from "./salestax";
import { accountActivity, inventoryValuation, journalReport, projectProfitability } from "./operational";
import { resolveParams, type Preset } from "./scope";
import type { ReportTable } from "./table";

export type ReportCategory = "Financial statements" | "Ledger" | "Receivables and payables" | "Tax" | "Operations" | "Planning";

export interface ReportDef {
  key: string;
  title: string;
  description: string;
  category: ReportCategory;
  /** "range" reports take from/to; "asOf" reports take one date. */
  dates: "range" | "asOf";
  basis: boolean;
  compare?: Comparison[];
  dimensionColumns?: boolean;
  filters?: boolean;
  defaultPreset?: Preset;
  /** Extra controls the page shows. */
  extra?: ("detail" | "budget")[];
}

export const REPORTS: ReportDef[] = [
  {
    key: "profit-and-loss",
    title: "Profit and loss",
    description: "Income, cost of goods sold, expenses and net income for a period — compared with earlier periods, month by month, or by project, class, department, location or fund.",
    category: "Financial statements",
    dates: "range",
    basis: true,
    compare: ["none", "previous_period", "previous_year", "months", "quarters"],
    dimensionColumns: true,
    filters: true,
  },
  {
    key: "balance-sheet",
    title: "Balance sheet",
    description: "Assets, liabilities and equity on a date, with retained earnings and current-year earnings computed.",
    category: "Financial statements",
    dates: "asOf",
    basis: true,
    compare: ["none", "previous_period", "previous_year", "months", "quarters"],
    filters: true,
    defaultPreset: "this_month",
  },
  {
    key: "cash-flow",
    title: "Statement of cash flows",
    description: "Where cash came from and went, by the indirect method; ties to the change in cash accounts.",
    category: "Financial statements",
    dates: "range",
    basis: true,
  },
  {
    key: "trial-balance",
    title: "Trial balance",
    description: "Every account's debit or credit balance on a date. Always sums to zero.",
    category: "Ledger",
    dates: "asOf",
    basis: true,
    filters: true,
    defaultPreset: "this_month",
  },
  {
    key: "general-ledger",
    title: "General ledger",
    description: "Every line by account with running balances, entry numbers and sources. Every other report drills down to it.",
    category: "Ledger",
    dates: "range",
    basis: true,
    filters: true,
  },
  { key: "journal", title: "Journal", description: "Posted entries in a period with their lines, in date order.", category: "Ledger", dates: "range", basis: true, filters: true, defaultPreset: "this_month" },
  {
    key: "account-activity",
    title: "Account activity",
    description: "Opening balance, debits, credits and closing balance for every account in a period.",
    category: "Ledger",
    dates: "range",
    basis: true,
    filters: true,
  },
  {
    key: "ar-aging",
    title: "Accounts receivable aging",
    description: "What customers owe, by how far past due. The total equals accounts receivable.",
    category: "Receivables and payables",
    dates: "asOf",
    basis: false,
    extra: ["detail"],
    defaultPreset: "this_month",
  },
  {
    key: "ap-aging",
    title: "Accounts payable aging",
    description: "What is owed to vendors, by how far past due. The total equals accounts payable.",
    category: "Receivables and payables",
    dates: "asOf",
    basis: false,
    extra: ["detail"],
    defaultPreset: "this_month",
  },
  { key: "customer-balances", title: "Customer balances", description: "Balance and deposits held per customer.", category: "Receivables and payables", dates: "asOf", basis: false, defaultPreset: "this_month" },
  { key: "vendor-balances", title: "Vendor balances", description: "Balance and prepayments per vendor.", category: "Receivables and payables", dates: "asOf", basis: false, defaultPreset: "this_month" },
  {
    key: "sales-tax",
    title: "Sales tax liability",
    description: "Taxable and exempt sales, tax charged, collected, remitted and owed per jurisdiction. Gideon Books does not file returns.",
    category: "Tax",
    dates: "range",
    basis: false,
    defaultPreset: "last_quarter",
  },
  {
    key: "project-profitability",
    title: "Project profitability",
    description: "Income, costs, profit and margin by project.",
    category: "Operations",
    dates: "range",
    basis: true,
  },
  {
    key: "inventory-valuation",
    title: "Inventory valuation",
    description: "Stock on hand and its value by item, reconciled to the inventory accounts.",
    category: "Operations",
    dates: "asOf",
    basis: false,
    defaultPreset: "this_month",
  },
  {
    key: "budget-vs-actual",
    title: "Budget vs actual",
    description: "Each budget against what happened, with variances.",
    category: "Planning",
    dates: "range",
    basis: true,
    extra: ["budget"],
    defaultPreset: "this_fiscal_year",
  },
];

/** Reports built by other modules, and useful views of these reports, listed on the reports page. */
export const OTHER_REPORTS: { title: string; description: string; href: string; category: string }[] = [
  { title: "Profit and loss by fund", description: "Nonprofit activity with a column per fund (restricted and unrestricted).", href: "/reports/profit-and-loss?columns=fund", category: "Organization types" },
  { title: "Trust income", description: "Income and expenses allocated to trust income.", href: "/reports/profit-and-loss?trust=income", category: "Organization types" },
  { title: "Trust principal", description: "Receipts and disbursements allocated to principal.", href: "/reports/profit-and-loss?trust=principal", category: "Organization types" },
  { title: "Profit and loss by project", description: "A column per project.", href: "/reports/profit-and-loss?columns=project", category: "Operations" },
  { title: "Fixed asset rollforward", description: "Cost, accumulated depreciation and net book value, reconciled to the ledger.", href: "/assets/rollforward", category: "Operations" },
  { title: "Book-to-tax reconciliation", description: "Book amounts by tax category, adjustments, and the export for Gideon Tax.", href: "/tax", category: "Tax" },
  { title: "Entity groups", description: "Consolidated statements across organizations, with eliminations.", href: "/consolidation", category: "Multi-entity" },
];

export function reportDef(key: string): ReportDef | undefined {
  return REPORTS.find((r) => r.key === key);
}

const COMPARISONS: Comparison[] = ["none", "previous_period", "previous_year", "months", "quarters"];
const DIMENSIONS: Dimension[] = ["project", "class", "department", "location", "fund"];

export async function dimensionNames(db: DbOrTx, orgId: string, dim: Dimension): Promise<Map<string, string>> {
  if (dim === "project") {
    const rows = await db.select({ id: projects.id, name: projects.name }).from(projects).where(eq(projects.orgId, orgId)).orderBy(asc(projects.name));
    return new Map(rows.map((r) => [r.id, r.name]));
  }
  const rows = await db
    .select({ id: dimensionValues.id, name: dimensionValues.name })
    .from(dimensionValues)
    .where(and(eq(dimensionValues.orgId, orgId), eq(dimensionValues.kind, dim)));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Build any report's table from URL parameters. */
export async function buildReport(db: DbOrTx, org: Org, key: string, p: Record<string, string | undefined>): Promise<ReportTable> {
  const def = reportDef(key);
  if (!def) throw new Error(`unknown report ${key}`);
  const r = resolveParams(org, p, def.defaultPreset ?? "year_to_date");
  const compare = COMPARISONS.includes(p.compare as Comparison) ? (p.compare as Comparison) : "none";
  const columnsBy = DIMENSIONS.includes(p.columns as Dimension) ? (p.columns as Dimension) : null;
  switch (key) {
    case "profit-and-loss":
      return (
        await profitAndLoss(db, org, {
          from: r.from,
          to: r.to,
          basis: r.basis,
          filters: r.filters,
          compare,
          columnsBy,
          ...(columnsBy ? { dimensionNames: await dimensionNames(db, org.id, columnsBy) } : {}),
        })
      ).table;
    case "balance-sheet":
      return (await balanceSheet(db, org, { asOf: r.to, basis: r.basis, filters: r.filters, compare })).table;
    case "cash-flow":
      return (await cashFlow(db, org, { from: r.from, to: r.to, basis: r.basis })).table;
    case "trial-balance":
      return (await trialBalance(db, org, { asOf: r.to, basis: r.basis, filters: r.filters })).table;
    case "general-ledger":
      return (await generalLedger(db, org, { from: r.from, to: r.to, basis: r.basis, filters: r.filters, pageSize: null })).table;
    case "journal":
      return (await journalReport(db, org, { from: r.from, to: r.to, basis: r.basis, filters: r.filters })).table;
    case "account-activity":
      return (await accountActivity(db, org, { from: r.from, to: r.to, basis: r.basis, filters: r.filters })).table;
    case "ar-aging":
      return (await aging(db, org, { side: "receivables", asOf: r.to, detail: p.detail === "1" })).table;
    case "ap-aging":
      return (await aging(db, org, { side: "payables", asOf: r.to, detail: p.detail === "1" })).table;
    case "customer-balances":
      return (await contactBalances(db, org, { side: "receivables", asOf: r.to })).table;
    case "vendor-balances":
      return (await contactBalances(db, org, { side: "payables", asOf: r.to })).table;
    case "sales-tax":
      return (await salesTaxLiability(db, org, { from: r.from, to: r.to })).table;
    case "project-profitability":
      return (await projectProfitability(db, org, { from: r.from, to: r.to, basis: r.basis })).table;
    case "inventory-valuation":
      return (await inventoryValuation(db, org, { asOf: r.to })).table;
    case "budget-vs-actual": {
      if (!p.budget) throw new Error("budget required");
      return (await budgetVsActual(db, org, { budgetId: p.budget, from: r.from, to: r.to, basis: r.basis })).table;
    }
    default:
      throw new Error(`unknown report ${key}`);
  }
}
