/**
 * The financial statements: trial balance, balance sheet, profit and loss
 * and cash-flow statement. Each returns its figures (for checks and tests)
 * and a ReportTable (for the page, the CSV and the PDF).
 *
 * Signs: the ledger stores debits positive. Statements show each figure the
 * way it is read — income, liabilities and equity as positive credits,
 * expenses and assets as positive debits.
 *
 * Retained earnings on the balance sheet are computed, not closed: net income
 * of every fiscal year before the current one, plus anything posted to a
 * retained-earnings account; current-year earnings are net income from the
 * start of the fiscal year containing the balance-sheet date.
 */
import type { DbOrTx } from "@/lib/db/client";
import type { Org } from "@/lib/context";
import { Decimal } from "@/lib/money/decimal";
import { formatDate } from "@/lib/money/format";
import { addDays, addMonths, endOfMonth, startOfMonth } from "@/lib/dates";
import type { AccountSubtype } from "@/lib/db/schema/ledger";
import { SUBTYPE_LABELS } from "@/lib/ledger/accounts";
import { creditNormal, isProfitAndLoss, label, loadChart, type Chart, type ReportAccount } from "./accounts";
import { sumByAccount, sumByAccountAndDimension, type AccountAmount } from "./ledger";
import { filterParams, fyStartOf, hasFilters, type Basis, type LineFilters } from "./scope";
import { glHref, qs, type ReportColumn, type ReportRow, type ReportTable } from "./table";

export const BEGINNING = "1900-01-01";

export interface Column {
  label: string;
  from: string | null;
  to: string;
  /** Dimension-column value ("none" for unassigned), when columns are by dimension. */
  dimension?: { kind: Dimension; id: string };
}

export type Dimension = "project" | "class" | "department" | "location" | "fund";
export type Comparison = "none" | "previous_period" | "previous_year" | "months" | "quarters";

const BASIS_LABEL: Record<Basis, string> = { accrual: "Accrual basis", cash: "Cash basis" };

function zero(n: number): Decimal[] {
  return Array.from({ length: n }, () => Decimal.ZERO);
}

function rangeLabel(from: string | null, to: string): string {
  return from ? `${formatDate(from)} – ${formatDate(to)}` : `As of ${formatDate(to)}`;
}

/** Display sign for an account's balance. */
function display(a: Pick<ReportAccount, "type">, base: Decimal): Decimal {
  return creditNormal(a.type) ? base.neg() : base;
}

function amountOf(m: Map<string, AccountAmount>, id: string): Decimal {
  return m.get(id)?.base ?? Decimal.ZERO;
}

// ── Columns ──────────────────────────────────────────────────────────────────

/** Period columns for a profit-and-loss style report. */
export function periodColumns(from: string, to: string, compare: Comparison): Column[] {
  const main: Column = { label: rangeLabel(from, to), from, to };
  if (compare === "none") return [main];
  if (compare === "previous_year") {
    return [main, { label: rangeLabel(addMonths(from, -12), addMonths(to, -12)), from: addMonths(from, -12), to: addMonths(to, -12) }];
  }
  if (compare === "previous_period") {
    const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
    const pTo = addDays(from, -1);
    const pFrom = addDays(pTo, -(days - 1));
    // Whole months compare to the same number of whole months.
    const wholeMonths = from === startOfMonth(from) && to === endOfMonth(to);
    if (wholeMonths) {
      const months = (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + (Number(to.slice(5, 7)) - Number(from.slice(5, 7))) + 1;
      const f = addMonths(from, -months);
      return [main, { label: rangeLabel(f, endOfMonth(addMonths(f, months - 1))), from: f, to: endOfMonth(addMonths(f, months - 1)) }];
    }
    return [main, { label: rangeLabel(pFrom, pTo), from: pFrom, to: pTo }];
  }
  const step = compare === "months" ? 1 : 3;
  const cols: Column[] = [];
  let s = startOfMonth(from);
  for (let i = 0; i < 36 && s <= to; i++) {
    const e = endOfMonth(addMonths(s, step - 1));
    const cf = s < from ? from : s;
    const ct = e > to ? to : e;
    cols.push({ label: step === 1 ? cf.slice(0, 7) : `${formatDate(cf)} – ${formatDate(ct)}`, from: cf, to: ct });
    s = addMonths(s, step);
  }
  if (cols.length > 1) cols.push({ label: "Total", from, to });
  return cols;
}

/** As-of columns for a balance sheet. */
export function asOfColumns(asOf: string, compare: Comparison): Column[] {
  const main: Column = { label: `As of ${formatDate(asOf)}`, from: null, to: asOf };
  if (compare === "previous_year") return [main, { label: `As of ${formatDate(addMonths(asOf, -12))}`, from: null, to: addMonths(asOf, -12) }];
  if (compare === "previous_period") {
    const prev = addDays(startOfMonth(asOf), -1);
    return [main, { label: `As of ${formatDate(prev)}`, from: null, to: prev }];
  }
  if (compare === "months" || compare === "quarters") {
    const step = compare === "months" ? 1 : 3;
    const cols: Column[] = [];
    for (let i = 5; i >= 0; i--) {
      const d = i === 0 ? asOf : endOfMonth(addMonths(asOf, -i * step));
      cols.push({ label: `As of ${formatDate(d)}`, from: null, to: d });
    }
    return cols;
  }
  return [main];
}

// ── Grouped account rows ─────────────────────────────────────────────────────

interface SectionSpec {
  key: string;
  label: string;
  subtypes: AccountSubtype[];
}

interface Built {
  rows: ReportRow[];
  totals: Decimal[];
  /** Display amounts per account per column. */
  byAccount: Map<string, Decimal[]>;
  accountIds: string[];
}

/**
 * Rows for the accounts of a section, in chart order with subaccounts
 * indented under their parent and a total for each parent with children.
 */
function sectionRows(
  chart: Chart,
  spec: SectionSpec,
  amounts: (accountId: string) => Decimal[],
  cols: Column[],
  drill: (accountIds: string[], col: Column) => string | undefined,
  baseLevel: number,
): Built {
  const inSection = chart.ordered.filter((a) => spec.subtypes.includes(a.subtype));
  const ids = new Set(inSection.map((a) => a.id));
  const byAccount = new Map<string, Decimal[]>();
  for (const a of inSection) byAccount.set(a.id, amounts(a.id));
  const subtreeTotal = (id: string): Decimal[] => {
    const own = byAccount.get(id) ?? zero(cols.length);
    const kids = chart.ordered.filter((c) => c.parentId === id && ids.has(c.id));
    return kids.reduce((acc, k) => acc.map((v, i) => v.add(subtreeTotal(k.id)[i]!)), own);
  };
  const nonZero = (v: Decimal[]) => v.some((x) => !x.isZero());
  const rows: ReportRow[] = [];
  const emit = (a: ReportAccount, level: number) => {
    const sub = subtreeTotal(a.id);
    if (!nonZero(sub)) return;
    const kids = chart.ordered.filter((c) => c.parentId === a.id && ids.has(c.id) && nonZero(subtreeTotal(c.id)));
    const own = byAccount.get(a.id)!;
    rows.push({
      kind: "detail",
      level,
      cells: [{ value: label(a) }, ...cols.map((c, i) => ({ value: own[i]!.toString(), ...(kids.length && own[i]!.isZero() ? {} : { href: drill([a.id], c) }) }))],
    });
    for (const k of kids) emit(k, level + 1);
    if (kids.length) {
      const all = chart.descendants(a.id).filter((x) => ids.has(x));
      rows.push({ kind: "subtotal", level, cells: [{ value: `Total ${label(a)}` }, ...cols.map((c, i) => ({ value: sub[i]!.toString(), href: drill(all, c) }))] });
    }
  };
  for (const a of inSection) {
    // Roots of the section: accounts whose parent is not in the section.
    if (a.parentId && ids.has(a.parentId)) continue;
    emit(a, baseLevel);
  }
  const roots = inSection.filter((a) => !a.parentId || !ids.has(a.parentId));
  const totals = roots.reduce((acc, r) => acc.map((v, i) => v.add(subtreeTotal(r.id)[i]!)), zero(cols.length));
  return { rows, totals, byAccount, accountIds: inSection.map((a) => a.id) };
}

function headerColumns(first: string, cols: Column[]): ReportColumn[] {
  return [{ key: "label", label: first, kind: "text" }, ...cols.map((c, i) => ({ key: `c${i}`, label: c.label, kind: "money" as const, align: "right" as const }))];
}

function totalRow(labelText: string, values: Decimal[], kind: "subtotal" | "total", hrefs?: (string | undefined)[], level = 0): ReportRow {
  return { kind, level, cells: [{ value: labelText }, ...values.map((v, i) => ({ value: v.toString(), ...(hrefs?.[i] ? { href: hrefs[i] } : {}) }))] };
}

function sectionHeader(labelText: string, cols: number, level = 0): ReportRow {
  return { kind: "section", level, cells: [{ value: labelText }, ...Array.from({ length: cols }, () => ({ value: null }))] };
}

// ── Profit and loss ──────────────────────────────────────────────────────────

const PL_SECTIONS: SectionSpec[] = [
  { key: "income", label: "Income", subtypes: ["operating_income"] },
  { key: "cogs", label: "Cost of goods sold", subtypes: ["cost_of_goods_sold"] },
  { key: "expenses", label: "Expenses", subtypes: ["operating_expense", "payroll_expense", "depreciation_expense"] },
  { key: "other_income", label: "Other income", subtypes: ["other_income"] },
  { key: "other_expense", label: "Other expenses", subtypes: ["other_expense"] },
];

export interface ProfitAndLoss {
  table: ReportTable;
  columns: Column[];
  income: Decimal[];
  cogs: Decimal[];
  grossProfit: Decimal[];
  expenses: Decimal[];
  operatingIncome: Decimal[];
  otherIncome: Decimal[];
  otherExpense: Decimal[];
  netIncome: Decimal[];
  byAccount: Map<string, Decimal[]>;
}

export async function profitAndLoss(
  db: DbOrTx,
  org: Org,
  opts: { from: string; to: string; basis: Basis; filters?: LineFilters; compare?: Comparison; columnsBy?: Dimension | null; dimensionNames?: Map<string, string> },
): Promise<ProfitAndLoss> {
  const filters = opts.filters ?? {};
  const chart = await loadChart(db, org.id);
  let cols: Column[];
  let amounts: (id: string) => Decimal[];
  if (opts.columnsBy) {
    const dim = opts.columnsBy;
    const rows = await sumByAccountAndDimension(db, org.id, opts.basis, { from: opts.from, to: opts.to }, dim, filters);
    const dimIds = [...new Set(rows.map((r) => r.dimensionId ?? "none"))].sort((a, b) =>
      a === "none" ? 1 : b === "none" ? -1 : (opts.dimensionNames?.get(a) ?? a).localeCompare(opts.dimensionNames?.get(b) ?? b),
    );
    cols = [
      ...dimIds.map((id) => ({ label: id === "none" ? "Not assigned" : (opts.dimensionNames?.get(id) ?? id), from: opts.from, to: opts.to, dimension: { kind: dim, id } })),
      { label: "Total", from: opts.from, to: opts.to },
    ];
    const grid = new Map<string, Decimal[]>();
    for (const r of rows) {
      const acc = chart.byId.get(r.accountId);
      if (!acc) continue;
      const v = grid.get(r.accountId) ?? zero(cols.length);
      const i = dimIds.indexOf(r.dimensionId ?? "none");
      const d = display(acc, r.base);
      v[i] = v[i]!.add(d);
      v[cols.length - 1] = v[cols.length - 1]!.add(d);
      grid.set(r.accountId, v);
    }
    amounts = (id) => grid.get(id) ?? zero(cols.length);
  } else {
    cols = periodColumns(opts.from, opts.to, opts.compare ?? "none");
    const sums = await Promise.all(cols.map((c) => sumByAccount(db, org.id, opts.basis, { from: c.from, to: c.to }, filters)));
    amounts = (id) => {
      const acc = chart.byId.get(id)!;
      return sums.map((m) => display(acc, amountOf(m, id)));
    };
  }
  const fp = filterParams(filters);
  const drill = (ids: string[], c: Column) =>
    glHref({ account: ids.join(","), from: c.from ?? undefined, to: c.to, basis: opts.basis, ...fp, ...(c.dimension ? { [c.dimension.kind]: c.dimension.id } : {}) });
  const n = cols.length;
  const rows: ReportRow[] = [];
  const built: Record<string, Built> = {};
  const byAccount = new Map<string, Decimal[]>();
  for (const spec of PL_SECTIONS) {
    const b = sectionRows(chart, spec, amounts, cols, drill, 1);
    built[spec.key] = b;
    for (const [k, v] of b.byAccount) byAccount.set(k, v);
  }
  const sec = (key: string) => built[key]!;
  const hrefsFor = (ids: string[]) => cols.map((c) => (ids.length ? drill(ids, c) : undefined));
  const push = (key: string, title: string) => {
    const b = sec(key);
    if (!b.rows.length) return;
    rows.push(sectionHeader(title, n));
    rows.push(...b.rows);
    rows.push(totalRow(`Total ${title.toLowerCase()}`, b.totals, "subtotal", hrefsFor(b.accountIds)));
  };
  push("income", "Income");
  push("cogs", "Cost of goods sold");
  const grossProfit = sec("income").totals.map((v, i) => v.sub(sec("cogs").totals[i]!));
  if (sec("cogs").rows.length) rows.push(totalRow("Gross profit", grossProfit, "total"));
  push("expenses", "Expenses");
  const operatingIncome = grossProfit.map((v, i) => v.sub(sec("expenses").totals[i]!));
  rows.push(totalRow("Net operating income", operatingIncome, "total"));
  push("other_income", "Other income");
  push("other_expense", "Other expenses");
  const netIncome = operatingIncome.map((v, i) => v.add(sec("other_income").totals[i]!).sub(sec("other_expense").totals[i]!));
  const plIds = chart.ordered.filter((a) => isProfitAndLoss(a.type)).map((a) => a.id);
  rows.push(totalRow(org.entityType === "nonprofit" ? "Change in net assets" : "Net income", netIncome, "total", hrefsFor(plIds)));
  const notes = [`${BASIS_LABEL[opts.basis]}. Amounts in ${org.baseCurrency}. Each figure links to the ledger lines behind it.`];
  if (hasFilters(filters)) notes.push("Filtered: only lines matching the filters are included.");
  return {
    table: {
      key: "profit-and-loss",
      title: org.entityType === "nonprofit" ? "Statement of activities" : "Profit and loss",
      subtitle: `${rangeLabel(opts.from, opts.to)} · ${BASIS_LABEL[opts.basis]}`,
      currency: org.baseCurrency,
      columns: headerColumns("Account", cols),
      rows,
      notes,
    },
    columns: cols,
    income: sec("income").totals,
    cogs: sec("cogs").totals,
    grossProfit,
    expenses: sec("expenses").totals,
    operatingIncome,
    otherIncome: sec("other_income").totals,
    otherExpense: sec("other_expense").totals,
    netIncome,
    byAccount,
  };
}

// ── Balance sheet ────────────────────────────────────────────────────────────

const BS_SECTIONS: { group: "assets" | "liabilities" | "equity"; spec: SectionSpec }[] = [
  { group: "assets", spec: { key: "current_assets", label: "Current assets", subtypes: ["bank", "cash", "clearing", "accounts_receivable", "inventory", "other_current_asset", "prepaid_expense"] } },
  { group: "assets", spec: { key: "fixed_assets", label: "Fixed assets", subtypes: ["fixed_asset", "accumulated_depreciation"] } },
  { group: "assets", spec: { key: "other_assets", label: "Other assets", subtypes: ["other_asset"] } },
  {
    group: "liabilities",
    spec: { key: "current_liabilities", label: "Current liabilities", subtypes: ["credit_card", "accounts_payable", "sales_tax_payable", "payroll_liability", "customer_deposits", "other_current_liability"] },
  },
  { group: "liabilities", spec: { key: "long_term_liabilities", label: "Long-term liabilities", subtypes: ["long_term_liability"] } },
  {
    group: "equity",
    spec: {
      key: "equity",
      label: "Equity",
      subtypes: ["owner_equity", "owner_contributions", "owner_draws", "opening_balance_equity", "retained_earnings", "net_assets_unrestricted", "net_assets_restricted", "trust_principal", "trust_income"],
    },
  },
];

export interface BalanceSheet {
  table: ReportTable;
  columns: Column[];
  totalAssets: Decimal[];
  totalLiabilities: Decimal[];
  totalEquity: Decimal[];
  /** Net income of fiscal years before the current one (as shown, credit positive). */
  priorEarnings: Decimal[];
  currentEarnings: Decimal[];
  byAccount: Map<string, Decimal[]>;
  /** Assets − (liabilities + equity), per column; zero when it balances. */
  difference: Decimal[];
}

export async function balanceSheet(db: DbOrTx, org: Org, opts: { asOf: string; basis: Basis; filters?: LineFilters; compare?: Comparison }): Promise<BalanceSheet> {
  const filters = opts.filters ?? {};
  const chart = await loadChart(db, org.id);
  const cols = asOfColumns(opts.asOf, opts.compare ?? "none");
  const n = cols.length;
  const cumulative = await Promise.all(cols.map((c) => sumByAccount(db, org.id, opts.basis, { to: c.to }, filters)));
  const currentYear = await Promise.all(cols.map((c) => sumByAccount(db, org.id, opts.basis, { from: fyStartOf(org, c.to), to: c.to }, filters)));
  const plAccounts = chart.ordered.filter((a) => isProfitAndLoss(a.type));
  const currentEarnings = currentYear.map((m) => Decimal.sum(plAccounts.map((a) => amountOf(m, a.id))).neg());
  const priorEarnings = cumulative.map((m, i) => Decimal.sum(plAccounts.map((a) => amountOf(m, a.id))).neg().sub(currentEarnings[i]!));
  const amounts = (id: string) => {
    const acc = chart.byId.get(id)!;
    return cumulative.map((m) => display(acc, amountOf(m, id)));
  };
  const fp = filterParams(filters);
  const drill = (ids: string[], c: Column) => glHref({ account: ids.join(","), to: c.to, basis: opts.basis, ...fp });
  const rows: ReportRow[] = [];
  const byAccount = new Map<string, Decimal[]>();
  const groupTotals = { assets: zero(n), liabilities: zero(n), equity: zero(n) };
  const groupIds: Record<string, string[]> = { assets: [], liabilities: [], equity: [] };
  const groupLabel = { assets: "Assets", liabilities: "Liabilities", equity: org.entityType === "nonprofit" ? "Net assets" : "Equity" };
  let currentGroup: string | null = null;
  const closeGroup = (g: "assets" | "liabilities" | "equity") => {
    if (g === "equity") {
      const plIds = plAccounts.map((a) => a.id);
      rows.push({
        kind: "detail",
        level: 1,
        cells: [
          { value: org.entityType === "nonprofit" ? "Accumulated change in net assets (prior years)" : "Retained earnings (prior years' net income)" },
          ...cols.map((c, i) => ({ value: priorEarnings[i]!.toString(), href: `/reports/profit-and-loss?${qs({ from: BEGINNING, to: addDays(fyStartOf(org, c.to), -1), basis: opts.basis, ...fp })}` })),
        ],
      });
      rows.push({
        kind: "detail",
        level: 1,
        cells: [
          { value: org.entityType === "nonprofit" ? "Change in net assets (current year)" : "Net income (current year)" },
          ...cols.map((c, i) => ({ value: currentEarnings[i]!.toString(), href: `/reports/profit-and-loss?${qs({ from: fyStartOf(org, c.to), to: c.to, basis: opts.basis, ...fp })}` })),
        ],
      });
      groupTotals.equity = groupTotals.equity.map((v, i) => v.add(priorEarnings[i]!).add(currentEarnings[i]!));
      groupIds.equity!.push(...plIds);
    }
    rows.push(totalRow(`Total ${groupLabel[g].toLowerCase()}`, groupTotals[g], "subtotal", cols.map((c) => drill(groupIds[g]!, c))));
  };
  for (const { group, spec } of BS_SECTIONS) {
    if (currentGroup !== group) {
      if (currentGroup) closeGroup(currentGroup as "assets" | "liabilities" | "equity");
      rows.push(sectionHeader(groupLabel[group], n));
      currentGroup = group;
    }
    const b = sectionRows(chart, spec, amounts, cols, drill, 2);
    for (const [k, v] of b.byAccount) byAccount.set(k, v);
    groupTotals[group] = groupTotals[group].map((v, i) => v.add(b.totals[i]!));
    groupIds[group]!.push(...b.accountIds);
    if (b.rows.length && spec.key !== "equity") {
      rows.push(sectionHeader(spec.label, n, 1));
      rows.push(...b.rows);
      rows.push(totalRow(`Total ${spec.label.toLowerCase()}`, b.totals, "subtotal", cols.map((c) => drill(b.accountIds, c)), 1));
    } else if (b.rows.length) {
      rows.push(...b.rows);
    }
  }
  if (currentGroup) closeGroup(currentGroup as "equity");
  const le = groupTotals.liabilities.map((v, i) => v.add(groupTotals.equity[i]!));
  rows.push(totalRow(`Total liabilities and ${groupLabel.equity.toLowerCase()}`, le, "total"));
  // Move "Total assets" to read as a total.
  const difference = groupTotals.assets.map((v, i) => v.sub(le[i]!));
  const warnings: string[] = [];
  difference.forEach((d, i) => {
    if (!d.isZero()) warnings.push(`${cols[i]!.label}: assets and liabilities plus equity differ by ${d.toString()} ${org.baseCurrency}${hasFilters(filters) ? " (the report is filtered, so it need not balance)" : ""}.`);
  });
  const notes = [`${BASIS_LABEL[opts.basis]}. Amounts in ${org.baseCurrency}. Retained earnings are computed: net income of earlier fiscal years plus postings to retained-earnings accounts.`];
  if (opts.basis === "cash") notes.push("On the cash basis, receivables and payables are not shown; unapplied customer payments, deposits and vendor prepayments remain as balances.");
  if (hasFilters(filters)) notes.push("Filtered: only lines matching the filters are included.");
  return {
    table: {
      key: "balance-sheet",
      title: org.entityType === "nonprofit" ? "Statement of financial position" : "Balance sheet",
      subtitle: `As of ${formatDate(opts.asOf)} · ${BASIS_LABEL[opts.basis]}`,
      currency: org.baseCurrency,
      columns: headerColumns("Account", cols),
      rows: markTotalAssets(rows),
      notes,
      ...(warnings.length ? { warnings } : {}),
    },
    columns: cols,
    totalAssets: groupTotals.assets,
    totalLiabilities: groupTotals.liabilities,
    totalEquity: groupTotals.equity,
    priorEarnings,
    currentEarnings,
    byAccount,
    difference,
  };
}

function markTotalAssets(rows: ReportRow[]): ReportRow[] {
  return rows.map((r) => (r.cells[0]?.value === "Total assets" ? { ...r, kind: "total" } : r));
}

// ── Trial balance ────────────────────────────────────────────────────────────

export interface TrialBalance {
  table: ReportTable;
  rows: { accountId: string | null; label: string; debit: Decimal; credit: Decimal }[];
  totalDebit: Decimal;
  totalCredit: Decimal;
}

/**
 * Trial balance as of a date: balance-sheet accounts with their balances,
 * profit-and-loss accounts for the fiscal year to date, and the prior years'
 * net income as one retained-earnings line, so it sums to zero.
 */
export async function trialBalance(db: DbOrTx, org: Org, opts: { asOf: string; basis: Basis; filters?: LineFilters }): Promise<TrialBalance> {
  const filters = opts.filters ?? {};
  const chart = await loadChart(db, org.id);
  const fyStart = fyStartOf(org, opts.asOf);
  const all = await sumByAccount(db, org.id, opts.basis, { to: opts.asOf }, filters);
  const ytd = await sumByAccount(db, org.id, opts.basis, { from: fyStart, to: opts.asOf }, filters);
  const fp = filterParams(filters);
  const out: TrialBalance["rows"] = [];
  const tableRows: ReportRow[] = [];
  let prior = Decimal.ZERO;
  for (const a of chart.ordered) {
    const pl = isProfitAndLoss(a.type);
    const bal = pl ? amountOf(ytd, a.id) : amountOf(all, a.id);
    if (pl) prior = prior.add(amountOf(all, a.id).sub(amountOf(ytd, a.id)));
    if (bal.isZero()) continue;
    const debit = bal.isPositive() ? bal : Decimal.ZERO;
    const credit = bal.isNegative() ? bal.neg() : Decimal.ZERO;
    out.push({ accountId: a.id, label: label(a), debit, credit });
    const href = glHref({ account: a.id, ...(pl ? { from: fyStart } : {}), to: opts.asOf, basis: opts.basis, ...fp });
    tableRows.push({ kind: "detail", cells: [{ value: label(a) }, { value: SUBTYPE_LABELS[a.subtype] }, { value: debit.isZero() ? null : debit.toString(), href }, { value: credit.isZero() ? null : credit.toString(), href }] });
  }
  if (!prior.isZero()) {
    const debit = prior.isPositive() ? prior : Decimal.ZERO;
    const credit = prior.isNegative() ? prior.neg() : Decimal.ZERO;
    out.push({ accountId: null, label: "Retained earnings (prior years' net income)", debit, credit });
    const href = `/reports/profit-and-loss?${qs({ from: BEGINNING, to: addDays(fyStart, -1), basis: opts.basis, ...fp })}`;
    tableRows.push({ kind: "detail", cells: [{ value: "Retained earnings (prior years' net income)" }, { value: "Computed" }, { value: debit.isZero() ? null : debit.toString(), href }, { value: credit.isZero() ? null : credit.toString(), href }] });
  }
  const totalDebit = Decimal.sum(out.map((r) => r.debit));
  const totalCredit = Decimal.sum(out.map((r) => r.credit));
  tableRows.push({ kind: "total", cells: [{ value: "Total" }, { value: null }, { value: totalDebit.toString() }, { value: totalCredit.toString() }] });
  const warnings = totalDebit.eq(totalCredit) ? [] : [`Debits and credits differ by ${totalDebit.sub(totalCredit).abs().toString()} ${org.baseCurrency}${hasFilters(filters) ? " (filtered)" : ""}.`];
  return {
    table: {
      key: "trial-balance",
      title: "Trial balance",
      subtitle: `As of ${formatDate(opts.asOf)} · ${BASIS_LABEL[opts.basis]}`,
      currency: org.baseCurrency,
      columns: [
        { key: "account", label: "Account", kind: "text" },
        { key: "type", label: "Type", kind: "text" },
        { key: "debit", label: "Debit", kind: "money", align: "right" },
        { key: "credit", label: "Credit", kind: "money", align: "right" },
      ],
      rows: tableRows,
      notes: [`Income and expense accounts show the fiscal year from ${formatDate(fyStart)}; earlier years' net income is the retained-earnings line.`],
      ...(warnings.length ? { warnings } : {}),
    },
    rows: out,
    totalDebit,
    totalCredit,
  };
}

// ── Cash flow ────────────────────────────────────────────────────────────────

export interface CashFlow {
  table: ReportTable;
  netIncome: Decimal;
  operating: Decimal;
  investing: Decimal;
  financing: Decimal;
  other: Decimal;
  netChange: Decimal;
  cashBeginning: Decimal;
  cashEnding: Decimal;
  /** Net change minus the actual change in cash accounts (zero when it ties). */
  difference: Decimal;
}

/**
 * Indirect method. Net income, plus the change in every balance-sheet
 * account by its cash-flow section (accumulated depreciation is the
 * depreciation add-back; other operating accounts are working capital),
 * equals the change in the cash accounts. Accounts marked "not shown"
 * (retained earnings, opening balance equity) are listed separately so the
 * statement always ties out.
 */
export async function cashFlow(db: DbOrTx, org: Org, opts: { from: string; to: string; basis: Basis }): Promise<CashFlow> {
  const chart = await loadChart(db, org.id);
  const before = await sumByAccount(db, org.id, opts.basis, { to: addDays(opts.from, -1) });
  const after = await sumByAccount(db, org.id, opts.basis, { to: opts.to });
  const period = await sumByAccount(db, org.id, opts.basis, { from: opts.from, to: opts.to });
  const pl = chart.ordered.filter((a) => isProfitAndLoss(a.type));
  const netIncome = Decimal.sum(pl.map((a) => amountOf(period, a.id))).neg();
  const sections: Record<"operating" | "investing" | "financing" | "none", { account: ReportAccount; effect: Decimal }[]> = { operating: [], investing: [], financing: [], none: [] };
  let cashBeginning = Decimal.ZERO;
  let cashEnding = Decimal.ZERO;
  const cashIds: string[] = [];
  for (const a of chart.ordered) {
    if (isProfitAndLoss(a.type)) continue;
    const change = amountOf(after, a.id).sub(amountOf(before, a.id));
    if (a.cashFlowSection === "cash") {
      cashBeginning = cashBeginning.add(amountOf(before, a.id));
      cashEnding = cashEnding.add(amountOf(after, a.id));
      cashIds.push(a.id);
      continue;
    }
    if (change.isZero()) continue;
    sections[a.cashFlowSection === "none" ? "none" : a.cashFlowSection].push({ account: a, effect: change.neg() });
  }
  const sum = (k: keyof typeof sections) => Decimal.sum(sections[k].map((x) => x.effect));
  const operatingAdjustments = sum("operating");
  const operating = netIncome.add(operatingAdjustments);
  const investing = sum("investing");
  const financing = sum("financing");
  const other = sum("none");
  const netChange = operating.add(investing).add(financing).add(other);
  const difference = netChange.sub(cashEnding.sub(cashBeginning));
  const href = (ids: string[]) => glHref({ account: ids.join(","), from: opts.from, to: opts.to, basis: opts.basis });
  const rows: ReportRow[] = [];
  const line = (text: string, v: Decimal, level: number, kind: ReportRow["kind"], h?: string) =>
    rows.push({ kind, level, cells: [{ value: text }, { value: v.toString(), ...(h ? { href: h } : {}) }] });
  rows.push(sectionHeader("Operating activities", 1));
  line(org.entityType === "nonprofit" ? "Change in net assets" : "Net income", netIncome, 1, "detail", `/reports/profit-and-loss?${qs({ from: opts.from, to: opts.to, basis: opts.basis })}`);
  const dep = sections.operating.filter((x) => x.account.subtype === "accumulated_depreciation");
  const wc = sections.operating.filter((x) => x.account.subtype !== "accumulated_depreciation");
  if (dep.length) {
    rows.push(sectionHeader("Adjustments for non-cash items", 1, 1));
    for (const x of dep) line(`Depreciation (${label(x.account)})`, x.effect, 2, "detail", href([x.account.id]));
  }
  if (wc.length) {
    rows.push(sectionHeader("Changes in working capital", 1, 1));
    for (const x of wc) line(label(x.account), x.effect, 2, "detail", href([x.account.id]));
  }
  line("Net cash from operating activities", operating, 0, "subtotal");
  for (const [k, title] of [
    ["investing", "Investing activities"],
    ["financing", "Financing activities"],
    ["none", "Opening balances and retained-earnings adjustments"],
  ] as const) {
    if (!sections[k].length) continue;
    rows.push(sectionHeader(title, 1));
    for (const x of sections[k]) line(label(x.account), x.effect, 1, "detail", href([x.account.id]));
    line(`Net cash from ${title.toLowerCase()}`, sum(k), 0, "subtotal");
  }
  line("Net change in cash", netChange, 0, "total");
  line("Cash at beginning of period", cashBeginning, 0, "detail", glHref({ account: cashIds.join(","), to: addDays(opts.from, -1), basis: opts.basis }));
  line("Cash at end of period", cashEnding, 0, "total", glHref({ account: cashIds.join(","), to: opts.to, basis: opts.basis }));
  const warnings = difference.isZero()
    ? []
    : [`The statement does not tie out: the net change differs from the change in cash accounts by ${difference.toString()} ${org.baseCurrency}. Check the cash-flow sections of the accounts in the chart of accounts.`];
  return {
    table: {
      key: "cash-flow",
      title: "Statement of cash flows",
      subtitle: `${rangeLabel(opts.from, opts.to)} · ${BASIS_LABEL[opts.basis]} · Indirect method`,
      currency: org.baseCurrency,
      columns: [
        { key: "label", label: "", kind: "text" },
        { key: "amount", label: "Amount", kind: "money", align: "right" },
      ],
      rows,
      notes: ["Each balance-sheet account is classified by its cash-flow section (set on the account). Cash and cash equivalents are the bank, cash and clearing accounts."],
      ...(warnings.length ? { warnings } : {}),
    },
    netIncome,
    operating,
    investing,
    financing,
    other,
    netChange,
    cashBeginning,
    cashEnding,
    difference,
  };
}
