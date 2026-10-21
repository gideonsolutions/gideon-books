/**
 * Tax-return line catalogs, taken from Gideon Tax's own form definitions
 * (the gideon-tax-backends repository), so a mapping names the same lines
 * Gideon Tax files. Each catalog records the source file, commit and tax
 * year it was read from. Only the lines a set of books can supply directly
 * are listed (page-1 income, cost of goods sold and deductions); lines the
 * return computes, or that come from other schedules, are not.
 *
 * Forms not found in gideon-tax-backends are not offered — they are not
 * reconstructed from memory. Organizations can add their own categories.
 *
 * Besides form lines, three Gideon Books categories exist for every return
 * type, clearly not form lines: nondeductible expenses, nontaxable income,
 * and items stated separately on Schedule K (mapped by hand in Gideon Tax).
 */
import type { TaxReturnType } from "@/lib/db/schema/taxexport";

export type CategoryKind = "income" | "deduction" | "cogs" | "nondeductible" | "nontaxable" | "separately_stated";

export interface TaxCategory {
  code: string;
  /** The form line, e.g. "1a"; null for Gideon Books categories. */
  line: string | null;
  description: string;
  kind: CategoryKind;
  /** Built-in, or defined by the organization. */
  origin: "catalog" | "books" | "custom";
}

export interface Catalog {
  returnType: TaxReturnType;
  name: string;
  taxYear: string | null;
  /** The IRS MeF schema package the source builds against. */
  package: string | null;
  source: { repository: string; path: string; commit: string; read: string } | null;
  categories: TaxCategory[];
}

const SOURCE_READ = "2026-10-21";

function lines(items: [string, string, CategoryKind][]): TaxCategory[] {
  return items.map(([line, description, kind]) => ({ code: `L${line}`, line, description, kind, origin: "catalog" as const }));
}

export const BOOKS_CATEGORIES: TaxCategory[] = [
  { code: "BK_NONDEDUCTIBLE", line: null, description: "Not deductible (e.g. penalties, the nondeductible share of meals)", kind: "nondeductible", origin: "books" },
  { code: "BK_NONTAXABLE", line: null, description: "Not taxable income (e.g. tax-exempt interest)", kind: "nontaxable", origin: "books" },
  { code: "BK_SEPARATELY_STATED", line: null, description: "Separately stated item (Schedule K) — completed in Gideon Tax", kind: "separately_stated", origin: "books" },
];

export const CATALOGS: Catalog[] = [
  {
    returnType: "1120",
    name: "Form 1120 — U.S. Corporation Income Tax Return",
    taxYear: "2026",
    package: "2026v3.0",
    source: { repository: "gideon-tax-backends", path: "gideon-1120-backend/src/forms/returns/form_1120.rs", commit: "86107e7", read: SOURCE_READ },
    categories: lines([
      ["1a", "Gross receipts or sales", "income"],
      ["1b", "Returns and allowances", "income"],
      ["2", "Cost of goods sold (Form 1125-A line 8)", "cogs"],
      ["4", "Dividends and inclusions", "income"],
      ["5", "Interest", "income"],
      ["6", "Gross rents", "income"],
      ["7", "Gross royalties", "income"],
      ["8", "Capital gain net income (Schedule D)", "income"],
      ["9", "Net gain or (loss) from Form 4797", "income"],
      ["10", "Other income", "income"],
      ["12", "Compensation of officers (Form 1125-E)", "deduction"],
      ["13", "Salaries and wages (less employment credits)", "deduction"],
      ["14", "Repairs and maintenance", "deduction"],
      ["15", "Bad debts", "deduction"],
      ["16", "Rents", "deduction"],
      ["17", "Taxes and licenses", "deduction"],
      ["18", "Interest expense", "deduction"],
      ["19", "Charitable contributions", "deduction"],
      ["20", "Depreciation not claimed elsewhere (Form 4562)", "deduction"],
      ["21", "Depletion", "deduction"],
      ["22", "Advertising", "deduction"],
      ["23", "Pension, profit-sharing, etc., plans", "deduction"],
      ["24", "Employee benefit programs", "deduction"],
      ["25", "Energy efficient commercial buildings deduction (§179D)", "deduction"],
      ["26", "Other deductions", "deduction"],
    ]),
  },
  {
    returnType: "1120S",
    name: "Form 1120-S — U.S. Income Tax Return for an S Corporation",
    taxYear: "2026",
    package: "2026v3.0",
    source: { repository: "gideon-tax-backends", path: "gideon-1120-backend/src/forms/returns/form_1120s.rs", commit: "86107e7", read: SOURCE_READ },
    categories: lines([
      ["1a", "Gross receipts or sales", "income"],
      ["1b", "Returns and allowances", "income"],
      ["2", "Cost of goods sold (Form 1125-A line 8)", "cogs"],
      ["4", "Net gain (loss) from Form 4797", "income"],
      ["5", "Other income (loss)", "income"],
      ["7", "Compensation of officers", "deduction"],
      ["8", "Salaries and wages (less employment credits)", "deduction"],
      ["9", "Repairs and maintenance", "deduction"],
      ["10", "Bad debts", "deduction"],
      ["11", "Rents", "deduction"],
      ["12", "Taxes and licenses", "deduction"],
      ["13", "Interest expense", "deduction"],
      ["14", "Depreciation not claimed elsewhere (Form 4562)", "deduction"],
      ["15", "Depletion", "deduction"],
      ["16", "Advertising", "deduction"],
      ["17", "Pension, profit-sharing, etc., plans", "deduction"],
      ["18", "Employee benefit programs", "deduction"],
      ["19", "Energy efficient commercial buildings deduction (Form 7205)", "deduction"],
      ["20", "Other deductions", "deduction"],
    ]),
  },
  {
    returnType: "1065",
    name: "Form 1065 — U.S. Return of Partnership Income",
    taxYear: "2026",
    package: "2026v3.0",
    source: { repository: "gideon-tax-backends", path: "gideon-1065-backend/crates/gideon-1065-forms/src/returns/form_1065.rs", commit: "fdbd0e7", read: SOURCE_READ },
    categories: lines([
      ["1a", "Gross receipts or sales", "income"],
      ["1b", "Returns and allowances", "income"],
      ["2", "Cost of goods sold (Form 1125-A line 8)", "cogs"],
      ["4", "Ordinary income (loss) from other partnerships, estates, and trusts", "income"],
      ["5", "Net farm profit (loss) (Schedule F)", "income"],
      ["6", "Net gain (loss) from Form 4797, Part II, line 17", "income"],
      ["7", "Other income (loss)", "income"],
      ["9", "Salaries and wages (other than to partners), less credits", "deduction"],
      ["10", "Guaranteed payments to partners", "deduction"],
      ["11", "Repairs and maintenance", "deduction"],
      ["12", "Bad debts", "deduction"],
      ["13", "Rent", "deduction"],
      ["14", "Taxes and licenses", "deduction"],
      ["15", "Interest", "deduction"],
      ["16a", "Depreciation (Form 4562)", "deduction"],
      ["17", "Depletion", "deduction"],
      ["18", "Retirement plans, etc.", "deduction"],
      ["19", "Employee benefit programs", "deduction"],
      ["20", "Energy efficient commercial buildings deduction (Form 7205)", "deduction"],
      ["21", "Other deductions", "deduction"],
    ]),
  },
  {
    returnType: "schedule_c",
    name: "Schedule C (Form 1040) — Profit or Loss From Business",
    taxYear: "2025",
    package: "2025v5.3",
    source: { repository: "gideon-tax-backends", path: "gideon-1040-backend/crates/gideon-1040-forms/src/schedules/schedule_c.rs", commit: "2de688f", read: SOURCE_READ },
    categories: lines([
      ["1", "Gross receipts or sales", "income"],
      ["2", "Returns and allowances", "income"],
      ["4", "Cost of goods sold (Part III, line 42)", "cogs"],
      ["6", "Other income", "income"],
      ["8", "Advertising", "deduction"],
      ["9", "Car and truck expenses", "deduction"],
      ["10", "Commissions and fees", "deduction"],
      ["11", "Contract labor", "deduction"],
      ["12", "Depletion", "deduction"],
      ["13", "Depreciation and section 179 expense", "deduction"],
      ["14", "Employee benefit programs", "deduction"],
      ["15", "Insurance (other than health)", "deduction"],
      ["16a", "Mortgage interest paid to banks", "deduction"],
      ["16b", "Other interest", "deduction"],
      ["17", "Legal and professional services", "deduction"],
      ["18", "Office expense", "deduction"],
      ["19", "Pension and profit-sharing plans", "deduction"],
      ["20a", "Rent or lease of vehicles, machinery, and equipment", "deduction"],
      ["20b", "Rent or lease of other business property", "deduction"],
      ["21", "Repairs and maintenance", "deduction"],
      ["22", "Supplies", "deduction"],
      ["23", "Taxes and licenses", "deduction"],
      ["24a", "Travel", "deduction"],
      ["24b", "Deductible meals", "deduction"],
      ["25", "Utilities", "deduction"],
      ["26", "Wages (less employment credits)", "deduction"],
      ["27a", "Energy efficient commercial buildings deduction (Form 7205)", "deduction"],
      ["27b", "Other expenses (Part V)", "deduction"],
    ]),
  },
  {
    returnType: "custom",
    name: "Custom categories",
    taxYear: null,
    package: null,
    source: null,
    categories: [],
  },
];

export const RETURN_TYPE_LABELS: Record<TaxReturnType, string> = {
  "1120": "Form 1120 (C corporation)",
  "1120S": "Form 1120-S (S corporation)",
  "1065": "Form 1065 (partnership)",
  schedule_c: "Schedule C (sole proprietor)",
  custom: "Custom categories",
};

export function catalogFor(returnType: TaxReturnType): Catalog {
  return CATALOGS.find((c) => c.returnType === returnType)!;
}

/** Catalog categories plus the Gideon Books categories plus the organization's own. */
export function categoriesFor(returnType: TaxReturnType, custom: TaxCategory[]): TaxCategory[] {
  return [...catalogFor(returnType).categories, ...BOOKS_CATEGORIES, ...custom];
}

/** The return type that usually fits an organization's entity type. */
export function defaultReturnType(entityType: string): TaxReturnType {
  switch (entityType) {
    case "c_corporation":
      return "1120";
    case "s_corporation":
      return "1120S";
    case "partnership":
      return "1065";
    case "sole_proprietorship":
    case "llc":
      return "schedule_c";
    default:
      return "custom";
  }
}

/**
 * A suggested category for an account, only where the account's type or
 * name makes it unambiguous. Suggestions are saved unconfirmed; a person
 * confirms each before an export treats it as reviewed.
 */
export function suggestCategory(returnType: TaxReturnType, account: { type: string; subtype: string; name: string }): string | null {
  if (returnType === "custom") return null;
  const n = account.name.toLowerCase();
  const has = (...words: string[]) => words.some((w) => n.includes(w));
  const L = (byType: Partial<Record<TaxReturnType, string>>) => byType[returnType] ?? null;
  if (account.subtype === "cost_of_goods_sold") return L({ "1120": "L2", "1120S": "L2", "1065": "L2", schedule_c: "L4" });
  if (account.type === "income") {
    if (has("interest")) return L({ "1120": "L5", "1120S": "BK_SEPARATELY_STATED", "1065": "BK_SEPARATELY_STATED", schedule_c: "L6" });
    if (has("return", "allowance", "refunds")) return L({ "1120": "L1b", "1120S": "L1b", "1065": "L1b", schedule_c: "L2" });
    if (account.subtype === "operating_income") return L({ "1120": "L1a", "1120S": "L1a", "1065": "L1a", schedule_c: "L1" });
    return L({ "1120": "L10", "1120S": "L5", "1065": "L7", schedule_c: "L6" });
  }
  if (account.type !== "expense") return null;
  const rules: [boolean, Partial<Record<TaxReturnType, string>>][] = [
    [account.subtype === "depreciation_expense" || has("depreciation"), { "1120": "L20", "1120S": "L14", "1065": "L16a", schedule_c: "L13" }],
    [has("officer"), { "1120": "L12", "1120S": "L7" }],
    [has("guaranteed payment"), { "1065": "L10" }],
    [has("wage", "salar"), { "1120": "L13", "1120S": "L8", "1065": "L9", schedule_c: "L26" }],
    [has("payroll tax", "taxes", "license"), { "1120": "L17", "1120S": "L12", "1065": "L14", schedule_c: "L23" }],
    [has("benefit"), { "1120": "L24", "1120S": "L18", "1065": "L19", schedule_c: "L14" }],
    [has("pension", "retirement", "401(k)", "profit-sharing"), { "1120": "L23", "1120S": "L17", "1065": "L18", schedule_c: "L19" }],
    [has("repair", "maintenance"), { "1120": "L14", "1120S": "L9", "1065": "L11", schedule_c: "L21" }],
    [has("bad debt"), { "1120": "L15", "1120S": "L10", "1065": "L12" }],
    [has("rent"), { "1120": "L16", "1120S": "L11", "1065": "L13", schedule_c: "L20b" }],
    [has("interest"), { "1120": "L18", "1120S": "L13", "1065": "L15", schedule_c: "L16b" }],
    [has("advertising", "marketing"), { "1120": "L22", "1120S": "L16", schedule_c: "L8" }],
    [has("charit", "donation"), { "1120": "L19", "1120S": "BK_SEPARATELY_STATED", "1065": "BK_SEPARATELY_STATED" }],
    [has("contract labor"), { schedule_c: "L11" }],
    [has("legal", "professional", "accounting"), { schedule_c: "L17" }],
    [has("insurance"), { schedule_c: "L15" }],
    [has("travel"), { schedule_c: "L24a" }],
    [has("meal"), { schedule_c: "L24b" }],
    [has("utilit"), { schedule_c: "L25" }],
    [has("supplies"), { schedule_c: "L22" }],
    [has("office", "software"), { schedule_c: "L18" }],
    [has("vehicle", "car and truck", "mileage"), { schedule_c: "L9" }],
    [has("commission"), { schedule_c: "L10" }],
    [has("penalt", "fine"), { "1120": "BK_NONDEDUCTIBLE", "1120S": "BK_NONDEDUCTIBLE", "1065": "BK_NONDEDUCTIBLE", schedule_c: "BK_NONDEDUCTIBLE" }],
  ];
  for (const [matches, byType] of rules) {
    if (!matches) continue;
    const code = L(byType);
    if (code) return code;
  }
  return L({ "1120": "L26", "1120S": "L20", "1065": "L21", schedule_c: "L27b" });
}
