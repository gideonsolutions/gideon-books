/**
 * Operational reports: project profitability, inventory valuation, the
 * journal, and account activity.
 */
import { sql } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import type { Org } from "@/lib/context";
import { Decimal } from "@/lib/money/decimal";
import { formatDate } from "@/lib/money/format";
import { inventoryReconciliation } from "@/lib/inventory/valuation";
import { sourceHref } from "@/lib/web/links";
import { label, loadChart } from "./accounts";
import { filterSql, ledgerRows } from "./ledger";
import { filterParams, type Basis, type LineFilters } from "./scope";
import { glHref, type ReportRow, type ReportTable } from "./table";

const BASIS_LABEL: Record<Basis, string> = { accrual: "Accrual basis", cash: "Cash basis" };

// ── Project profitability ────────────────────────────────────────────────────

export interface ProjectRow {
  projectId: string;
  name: string;
  customer: string | null;
  status: string;
  income: Decimal;
  costs: Decimal;
  profit: Decimal;
  /** Profit as a percentage of income (null when there is no income). */
  margin: Decimal | null;
  budget: Decimal | null;
}

export async function projectProfitability(db: DbOrTx, org: Org, opts: { from: string; to: string; basis: Basis }): Promise<{ rows: ProjectRow[]; table: ReportTable }> {
  const res = await db.execute<{ project_id: string; type: string; base: string }>(sql`
    select lr.project_id::text, a.type, sum(lr.base_amount)::text as base
    from (${ledgerRows(org.id, opts.basis)}) lr
    join accounts a on a.org_id = ${org.id} and a.id = lr.account_id
    where lr.project_id is not null and lr.entry_date >= ${opts.from} and lr.entry_date <= ${opts.to} and a.type in ('income','expense')
    group by lr.project_id, a.type
  `);
  const projects = await db.execute<{ id: string; name: string; status: string; budget_amount: string | null; customer: string | null }>(sql`
    select p.id, p.name, p.status, p.budget_amount::text, c.display_name as customer
    from projects p left join contacts c on c.org_id = p.org_id and c.id = p.customer_id
    where p.org_id = ${org.id} order by p.name`);
  const chart = await loadChart(db, org.id);
  const incomeIds = chart.ordered.filter((a) => a.type === "income").map((a) => a.id).join(",");
  const expenseIds = chart.ordered.filter((a) => a.type === "expense").map((a) => a.id).join(",");
  const rows: ProjectRow[] = [];
  for (const p of projects.rows) {
    const income = Decimal.sum(res.rows.filter((r) => r.project_id === p.id && r.type === "income").map((r) => r.base)).neg();
    const costs = Decimal.sum(res.rows.filter((r) => r.project_id === p.id && r.type === "expense").map((r) => r.base));
    if (income.isZero() && costs.isZero() && p.status !== "active") continue;
    const profit = income.sub(costs);
    rows.push({
      projectId: p.id,
      name: p.name,
      customer: p.customer,
      status: p.status,
      income,
      costs,
      profit,
      margin: income.isZero() ? null : profit.mul(100).div(income, 1, "half_up"),
      budget: p.budget_amount ? Decimal.from(p.budget_amount) : null,
    });
  }
  const g = (project: string, accounts: string) => glHref({ account: accounts, from: opts.from, to: opts.to, basis: opts.basis, project });
  const table: ReportTable = {
    key: "project-profitability",
    title: "Project profitability",
    subtitle: `${formatDate(opts.from)} – ${formatDate(opts.to)} · ${BASIS_LABEL[opts.basis]}`,
    currency: org.baseCurrency,
    columns: [
      { key: "project", label: "Project", kind: "text" },
      { key: "customer", label: "Customer", kind: "text" },
      { key: "income", label: "Income", kind: "money", align: "right" },
      { key: "costs", label: "Costs", kind: "money", align: "right" },
      { key: "profit", label: "Profit", kind: "money", align: "right" },
      { key: "margin", label: "Margin", kind: "percent", align: "right" },
      { key: "budget", label: "Cost budget", kind: "money", align: "right" },
    ],
    rows: [
      ...rows.map(
        (r): ReportRow => ({
          kind: "detail",
          cells: [
            { value: r.name, href: `/projects/${r.projectId}` },
            { value: r.customer },
            { value: r.income.toString(), href: g(r.projectId, incomeIds) },
            { value: r.costs.toString(), href: g(r.projectId, expenseIds) },
            { value: r.profit.toString(), href: g(r.projectId, `${incomeIds},${expenseIds}`) },
            { value: r.margin?.toString() ?? null },
            { value: r.budget?.toString() ?? null },
          ],
        }),
      ),
      {
        kind: "total",
        cells: [
          { value: "Total" },
          { value: null },
          { value: Decimal.sum(rows.map((r) => r.income)).toString() },
          { value: Decimal.sum(rows.map((r) => r.costs)).toString() },
          { value: Decimal.sum(rows.map((r) => r.profit)).toString() },
          { value: null },
          { value: null },
        ],
      },
    ],
    notes: ["Income and costs are the ledger lines tagged with each project. Time and expenses not yet billed are on each project's page."],
  };
  return { rows, table };
}

// ── Inventory valuation ──────────────────────────────────────────────────────

export interface InventoryRow {
  itemId: string;
  name: string;
  sku: string | null;
  unit: string;
  quantity: Decimal;
  value: Decimal;
  averageCost: Decimal | null;
}

export async function inventoryValuation(db: DbOrTx, org: Org, opts: { asOf: string }) {
  const res = await db.execute<{ item_id: string; name: string; sku: string | null; unit: string; qty: string; value: string }>(sql`
    select i.id as item_id, i.name, i.sku, i.unit, coalesce(sum(m.quantity), 0)::text as qty, coalesce(sum(m.value), 0)::text as value
    from items i
    left join stock_moves m on m.org_id = i.org_id and m.item_id = i.id and m.move_date <= ${opts.asOf}
    where i.org_id = ${org.id} and i.kind = 'stock'
    group by i.id, i.name, i.sku, i.unit
    order by i.name`);
  const rows: InventoryRow[] = res.rows
    .map((r) => {
      const quantity = Decimal.from(r.qty);
      const value = Decimal.from(r.value);
      return { itemId: r.item_id, name: r.name, sku: r.sku, unit: r.unit, quantity, value, averageCost: quantity.isZero() ? null : value.div(quantity, 4, "half_up") };
    })
    .filter((r) => !r.quantity.isZero() || !r.value.isZero());
  const rec = await inventoryReconciliation(db, org.id, opts.asOf);
  const total = Decimal.sum(rows.map((r) => r.value));
  const tableRows: ReportRow[] = rows.map((r) => ({
    kind: "detail",
    cells: [
      { value: r.name, href: `/inventory/items/${r.itemId}` },
      { value: r.sku },
      { value: r.quantity.normalize().toString() },
      { value: r.unit },
      { value: r.averageCost?.toString() ?? null },
      { value: r.value.toString() },
    ],
  }));
  tableRows.push({ kind: "total", cells: [{ value: "Total stock value" }, { value: null }, { value: null }, { value: null }, { value: null }, { value: total.toString() }] });
  for (const a of rec.rows) {
    tableRows.push({
      kind: "note",
      cells: [
        { value: `Ledger ${a.accountCode} ${a.accountName}` },
        { value: null },
        { value: null },
        { value: null },
        { value: `difference ${a.difference}` },
        { value: a.ledgerValue, href: glHref({ account: a.accountId, to: opts.asOf, basis: "accrual" }) },
      ],
    });
  }
  const warnings = Decimal.from(rec.difference).isZero() ? [] : [`The stock ledger and the inventory accounts differ by ${rec.difference} ${org.baseCurrency}.`];
  return {
    rows,
    total,
    reconciliation: rec,
    table: {
      key: "inventory-valuation",
      title: "Inventory valuation",
      subtitle: `As of ${formatDate(opts.asOf)} · moving weighted-average cost`,
      currency: org.baseCurrency,
      columns: [
        { key: "item", label: "Item", kind: "text" },
        { key: "sku", label: "SKU", kind: "text" },
        { key: "qty", label: "On hand", kind: "number", align: "right" },
        { key: "unit", label: "Unit", kind: "text" },
        { key: "avg", label: "Average cost", kind: "money", align: "right" },
        { key: "value", label: "Value", kind: "money", align: "right" },
      ],
      rows: tableRows,
      notes: ["Quantities and values from the stock ledger as of the date; the ledger lines at the foot are the inventory accounts' balances, which must agree."],
      ...(warnings.length ? { warnings } : {}),
    } satisfies ReportTable,
  };
}

// ── Journal ──────────────────────────────────────────────────────────────────

export async function journalReport(db: DbOrTx, org: Org, opts: { from: string; to: string; basis: Basis; filters?: LineFilters; limit?: number }) {
  const filters = opts.filters ?? {};
  const chart = await loadChart(db, org.id);
  const res = await db.execute<{ entry_id: string; entry_number: number; entry_date: string; kind: string; source_type: string | null; source_id: string | null; source_ref: string | null; entry_description: string; account_id: string; description: string | null; base_amount: string; recognized: boolean }>(sql`
    select lr.entry_id, lr.entry_number, lr.entry_date, lr.kind, lr.source_type, lr.source_id, lr.source_ref, lr.entry_description,
           lr.account_id, lr.description, lr.base_amount::text, lr.recognized
    from (${ledgerRows(org.id, opts.basis)}) lr
    where ${filterSql(filters)} and lr.entry_date >= ${opts.from} and lr.entry_date <= ${opts.to}
    order by lr.entry_date, lr.entry_number, lr.recognized, lr.line_id
    ${opts.limit ? sql`limit ${opts.limit}` : sql``}
  `);
  const rows: ReportRow[] = [];
  let current: string | null = null;
  let debit = Decimal.ZERO;
  let credit = Decimal.ZERO;
  for (const r of res.rows) {
    if (r.entry_id !== current) {
      current = r.entry_id;
      rows.push({
        kind: "section",
        cells: [
          { value: r.entry_date },
          { value: `#${r.entry_number}`, href: `/accounting/journal/${r.entry_id}` },
          { value: `${r.kind.replace(/_/g, " ")}${r.source_ref ? ` ${r.source_ref}` : ""} — ${r.entry_description}`, ...(sourceHref("", r.source_type, r.source_id) ? { href: sourceHref("", r.source_type, r.source_id)! } : {}) },
          { value: null },
          { value: null },
        ],
      });
    }
    const amt = Decimal.from(r.base_amount);
    if (amt.isPositive()) debit = debit.add(amt);
    else credit = credit.add(amt.neg());
    const acc = chart.byId.get(r.account_id);
    rows.push({
      kind: "detail",
      level: 1,
      cells: [
        { value: null },
        { value: null },
        { value: `${acc ? label(acc) : r.account_id}${r.description ? ` — ${r.description}` : ""}${r.recognized ? " (cash-basis recognition)" : ""}` },
        { value: amt.isPositive() ? amt.toString() : null },
        { value: amt.isNegative() ? amt.neg().toString() : null },
      ],
    });
  }
  rows.push({ kind: "total", cells: [{ value: "Total" }, { value: null }, { value: null }, { value: debit.toString() }, { value: credit.toString() }] });
  return {
    debit,
    credit,
    table: {
      key: "journal",
      title: "Journal",
      subtitle: `${formatDate(opts.from)} – ${formatDate(opts.to)} · ${BASIS_LABEL[opts.basis]}`,
      currency: org.baseCurrency,
      columns: [
        { key: "date", label: "Date", kind: "date" },
        { key: "entry", label: "Entry", kind: "text" },
        { key: "description", label: "Account / description", kind: "text" },
        { key: "debit", label: "Debit", kind: "money", align: "right" },
        { key: "credit", label: "Credit", kind: "money", align: "right" },
      ],
      rows,
      notes: ["Every posted entry in the range with its lines. On the cash basis, invoices and bills appear as they are paid."],
    } satisfies ReportTable,
  };
}

// ── Account activity ─────────────────────────────────────────────────────────

/** Per account: opening balance, debits, credits and closing balance for the range. */
export async function accountActivity(db: DbOrTx, org: Org, opts: { from: string; to: string; basis: Basis; filters?: LineFilters }) {
  const filters = opts.filters ?? {};
  const chart = await loadChart(db, org.id);
  const res = await db.execute<{ account_id: string; opening: string; debits: string; credits: string; n: number }>(sql`
    select lr.account_id,
      coalesce(sum(lr.base_amount) filter (where lr.entry_date < ${opts.from}), 0)::text as opening,
      coalesce(sum(lr.base_amount) filter (where lr.entry_date >= ${opts.from} and lr.base_amount > 0), 0)::text as debits,
      coalesce(-sum(lr.base_amount) filter (where lr.entry_date >= ${opts.from} and lr.base_amount < 0), 0)::text as credits,
      (count(*) filter (where lr.entry_date >= ${opts.from}))::int as n
    from (${ledgerRows(org.id, opts.basis)}) lr
    where ${filterSql(filters)} and lr.entry_date <= ${opts.to}
    group by lr.account_id`);
  const m = new Map(res.rows.map((r) => [r.account_id, r]));
  const fp = filterParams(filters);
  const rows: ReportRow[] = [];
  for (const a of chart.ordered) {
    const r = m.get(a.id);
    if (!r) continue;
    const opening = Decimal.from(r.opening);
    const debits = Decimal.from(r.debits);
    const credits = Decimal.from(r.credits);
    const closing = opening.add(debits).sub(credits);
    if (opening.isZero() && r.n === 0) continue;
    const href = glHref({ account: a.id, from: opts.from, to: opts.to, basis: opts.basis, ...fp });
    rows.push({ kind: "detail", level: a.depth, cells: [{ value: label(a), href }, { value: opening.toString() }, { value: debits.toString(), href }, { value: credits.toString(), href }, { value: closing.toString() }, { value: String(r.n) }] });
  }
  return {
    table: {
      key: "account-activity",
      title: "Account activity",
      subtitle: `${formatDate(opts.from)} – ${formatDate(opts.to)} · ${BASIS_LABEL[opts.basis]}`,
      currency: org.baseCurrency,
      columns: [
        { key: "account", label: "Account", kind: "text" },
        { key: "opening", label: "Opening", kind: "money", align: "right" },
        { key: "debits", label: "Debits", kind: "money", align: "right" },
        { key: "credits", label: "Credits", kind: "money", align: "right" },
        { key: "closing", label: "Closing", kind: "money", align: "right" },
        { key: "lines", label: "Lines", kind: "number", align: "right" },
      ],
      rows,
      notes: ["Balances are debit-positive. Opening balances include everything before the start date."],
    } satisfies ReportTable,
  };
}
