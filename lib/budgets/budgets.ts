/**
 * Budgets: monthly amounts per income and expense account for a fiscal year,
 * optionally per project, class, department, location or fund; and the
 * budget-versus-actual comparison.
 *
 * Amounts are entered the natural way — income and expense budgets are
 * positive — and actuals are shown the same way, so variance = actual −
 * budget (above budget is positive for both).
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { withTransaction, type DbOrTx } from "@/lib/db/client";
import { budgetLines, budgets, BUDGET_DIMENSIONS, type BudgetDimension } from "@/lib/db/schema/planning";
import { accounts, dimensionValues, projects } from "@/lib/db/schema/ledger";
import { audit } from "@/lib/audit";
import { requirePermission, type Ctx, type Org } from "@/lib/context";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { Decimal } from "@/lib/money/decimal";
import { minorUnits } from "@/lib/money/currency";
import { formatDate } from "@/lib/money/format";
import { addDays, addMonths, endOfMonth, isIsoDate, startOfMonth } from "@/lib/dates";
import { creditNormal, label, loadChart } from "@/lib/reports/accounts";
import { ledgerRows } from "@/lib/reports/ledger";
import type { Basis } from "@/lib/reports/scope";
import { glHref, type ReportRow, type ReportTable } from "@/lib/reports/table";

export type Budget = typeof budgets.$inferSelect;
export type BudgetLine = typeof budgetLines.$inferSelect;

export function budgetMonths(fiscalYearStart: string): string[] {
  return Array.from({ length: 12 }, (_, i) => addMonths(fiscalYearStart, i));
}

export async function listBudgets(db: DbOrTx, orgId: string) {
  return db
    .select({
      budget: budgets,
      total: sql<string>`(select coalesce(sum(bl.amount), 0)::text from budget_lines bl where bl.budget_id = ${budgets.id})`,
      lines: sql<number>`(select count(*)::int from budget_lines bl where bl.budget_id = ${budgets.id})`,
    })
    .from(budgets)
    .where(eq(budgets.orgId, orgId))
    .orderBy(asc(budgets.fiscalYearStart), asc(budgets.name));
}

export async function getBudget(db: DbOrTx, orgId: string, id: string) {
  const [b] = await db.select().from(budgets).where(and(eq(budgets.orgId, orgId), eq(budgets.id, id)));
  if (!b) throw new NotFoundError("The budget");
  const lines = await db.select().from(budgetLines).where(and(eq(budgetLines.orgId, orgId), eq(budgetLines.budgetId, id)));
  return { budget: b, lines };
}

/** The dimension values a budget of this kind can be entered for. */
export async function dimensionChoices(db: DbOrTx, orgId: string, dimension: BudgetDimension | null) {
  if (!dimension) return [];
  if (dimension === "project") {
    const rows = await db.select({ id: projects.id, name: projects.name }).from(projects).where(eq(projects.orgId, orgId)).orderBy(asc(projects.name));
    return rows;
  }
  return db
    .select({ id: dimensionValues.id, name: dimensionValues.name })
    .from(dimensionValues)
    .where(and(eq(dimensionValues.orgId, orgId), eq(dimensionValues.kind, dimension), eq(dimensionValues.isArchived, false)))
    .orderBy(asc(dimensionValues.name));
}

/** Monthly actuals per account (and dimension value), shown the natural way. */
async function monthlyActuals(db: DbOrTx, org: Org, from: string, to: string, basis: Basis, dimension: BudgetDimension | null) {
  const dimCol = dimension ? sql.raw(`lr.${dimension}_id`) : sql`null`;
  const res = await db.execute<{ account_id: string; dim: string | null; month: string; base: string }>(sql`
    select lr.account_id, ${dimCol}::text as dim, to_char(date_trunc('month', lr.entry_date), 'YYYY-MM-DD') as month, sum(lr.base_amount)::text as base
    from (${ledgerRows(org.id, basis)}) lr
    join accounts a on a.org_id = ${org.id} and a.id = lr.account_id
    where a.type in ('income', 'expense') and lr.entry_date >= ${from} and lr.entry_date <= ${to}
    group by 1, 2, 3
  `);
  return res.rows;
}

export interface CreateBudgetInput {
  name: string;
  fiscalYearStart: string;
  dimension?: BudgetDimension | null;
  notes?: string | null;
  /** Start from last year's actuals, adjusted by a percentage. */
  copyActuals?: { basis: Basis; adjustPercent?: string | null } | null;
  /** Start from another budget. */
  copyBudgetId?: string | null;
}

export async function createBudget(ctx: Ctx, input: CreateBudgetInput): Promise<Budget> {
  requirePermission(ctx, "budgets.manage");
  const fields: Record<string, string> = {};
  if (!input.name?.trim()) fields.name = "Name the budget.";
  if (!isIsoDate(input.fiscalYearStart) || input.fiscalYearStart !== startOfMonth(input.fiscalYearStart)) fields.fiscalYearStart = "Pick the first day of a month.";
  if (input.dimension && !BUDGET_DIMENSIONS.includes(input.dimension)) fields.dimension = "Unknown dimension.";
  const adjust = input.copyActuals?.adjustPercent ? Decimal.tryFrom(input.copyActuals.adjustPercent.replace("%", "")) : Decimal.ZERO;
  if (!adjust) fields.adjustPercent = "Enter a percentage, e.g. 5 or -10.";
  if (Object.keys(fields).length) throw new ValidationError("Check the budget.", fields);
  return withTransaction(async (tx) => {
    const [clash] = await tx.select({ id: budgets.id }).from(budgets).where(and(eq(budgets.orgId, ctx.orgId), eq(budgets.name, input.name.trim())));
    if (clash) throw new ConflictError("A budget with that name exists.", "duplicate");
    const [b] = await tx
      .insert(budgets)
      .values({ orgId: ctx.orgId, name: input.name.trim(), fiscalYearStart: input.fiscalYearStart, dimension: input.dimension ?? null, notes: input.notes ?? null, createdBy: ctx.actor.userId })
      .returning();
    const mu = minorUnits(ctx.org.baseCurrency);
    const cells: { accountId: string; dimensionKey: string; periodStart: string; amount: Decimal }[] = [];
    if (input.copyActuals) {
      const prevStart = addMonths(input.fiscalYearStart, -12);
      const rows = await monthlyActuals(tx, ctx.org, prevStart, addDays(input.fiscalYearStart, -1), input.copyActuals.basis, input.dimension ?? null);
      const chart = await loadChart(tx, ctx.orgId);
      const factor = Decimal.ONE.add(adjust!.div(100, 8, "half_up"));
      for (const r of rows) {
        const acc = chart.byId.get(r.account_id);
        if (!acc) continue;
        const natural = creditNormal(acc.type) ? Decimal.from(r.base).neg() : Decimal.from(r.base);
        const amount = natural.mul(factor).round(mu, "half_up");
        if (amount.isZero()) continue;
        cells.push({ accountId: r.account_id, dimensionKey: r.dim ?? "", periodStart: addMonths(r.month, 12), amount });
      }
    } else if (input.copyBudgetId) {
      const src = await tx.select().from(budgetLines).where(and(eq(budgetLines.orgId, ctx.orgId), eq(budgetLines.budgetId, input.copyBudgetId)));
      const [srcBudget] = await tx.select().from(budgets).where(and(eq(budgets.orgId, ctx.orgId), eq(budgets.id, input.copyBudgetId)));
      if (!srcBudget) throw new NotFoundError("The budget to copy");
      const offset = monthsBetween(srcBudget.fiscalYearStart, input.fiscalYearStart);
      for (const l of src) {
        if ((srcBudget.dimension ?? null) !== (input.dimension ?? null) && l.dimensionKey) continue;
        cells.push({ accountId: l.accountId, dimensionKey: l.dimensionKey, periodStart: addMonths(l.periodStart, offset), amount: Decimal.from(l.amount) });
      }
    }
    if (cells.length) await writeCells(tx, ctx, b!, cells);
    await audit(tx, ctx, { action: "budget.created", entityType: "budget", entityId: b!.id, metadata: { name: b!.name, fiscalYearStart: b!.fiscalYearStart, dimension: b!.dimension, lines: cells.length } });
    return b!;
  });
}

function monthsBetween(a: string, b: string): number {
  return (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + (Number(b.slice(5, 7)) - Number(a.slice(5, 7)));
}

async function writeCells(tx: DbOrTx, ctx: Ctx, b: Budget, cells: { accountId: string; dimensionKey: string; periodStart: string; amount: Decimal }[]) {
  const months = new Set(budgetMonths(b.fiscalYearStart));
  for (const c of cells) {
    if (!months.has(c.periodStart)) continue;
    const projectId = b.dimension === "project" && c.dimensionKey ? c.dimensionKey : null;
    const dimensionValueId = b.dimension && b.dimension !== "project" && c.dimensionKey ? c.dimensionKey : null;
    if (c.amount.isZero()) {
      await tx
        .delete(budgetLines)
        .where(and(eq(budgetLines.budgetId, b.id), eq(budgetLines.accountId, c.accountId), eq(budgetLines.dimensionKey, c.dimensionKey), eq(budgetLines.periodStart, c.periodStart)));
      continue;
    }
    await tx
      .insert(budgetLines)
      .values({ orgId: ctx.orgId, budgetId: b.id, accountId: c.accountId, projectId, dimensionValueId, dimensionKey: c.dimensionKey, periodStart: c.periodStart, amount: c.amount.toString() })
      .onConflictDoUpdate({ target: [budgetLines.budgetId, budgetLines.accountId, budgetLines.dimensionKey, budgetLines.periodStart], set: { amount: c.amount.toString() } });
  }
}

/**
 * Save a grid of cells (account × dimension value × month). A blank or zero
 * cell removes it. Amounts must fit the base currency.
 */
export async function saveBudgetCells(ctx: Ctx, budgetId: string, cells: { accountId: string; dimensionKey: string; periodStart: string; amount: string | null }[]) {
  requirePermission(ctx, "budgets.manage");
  const mu = minorUnits(ctx.org.baseCurrency);
  const parsed: { accountId: string; dimensionKey: string; periodStart: string; amount: Decimal }[] = [];
  const fields: Record<string, string> = {};
  for (const c of cells) {
    const raw = (c.amount ?? "").replace(/[,\s$]/g, "");
    const d = raw === "" ? Decimal.ZERO : Decimal.tryFrom(raw);
    if (!d) {
      fields[`cell.${c.accountId}.${c.dimensionKey}.${c.periodStart}`] = "Not a number.";
      continue;
    }
    if (d.decimalPlaces > mu) {
      fields[`cell.${c.accountId}.${c.dimensionKey}.${c.periodStart}`] = `At most ${mu} decimal places.`;
      continue;
    }
    parsed.push({ ...c, amount: d });
  }
  if (Object.keys(fields).length) throw new ValidationError("Some amounts are not valid.", fields);
  return withTransaction(async (tx) => {
    const [b] = await tx.select().from(budgets).where(and(eq(budgets.orgId, ctx.orgId), eq(budgets.id, budgetId))).for("update");
    if (!b) throw new NotFoundError("The budget");
    const accIds = [...new Set(parsed.map((p) => p.accountId))];
    if (accIds.length) {
      const rows = await tx.select({ id: accounts.id, type: accounts.type }).from(accounts).where(and(eq(accounts.orgId, ctx.orgId), sql`${accounts.id} in (${sql.join(accIds.map((i) => sql`${i}::uuid`), sql`, `)})`));
      if (rows.length !== accIds.length || rows.some((r) => r.type !== "income" && r.type !== "expense")) {
        throw new ValidationError("Budgets cover income and expense accounts of this organization only.");
      }
    }
    await writeCells(tx, ctx, b, parsed);
    await tx.update(budgets).set({ updatedAt: new Date() }).where(eq(budgets.id, b.id));
    await audit(tx, ctx, { action: "budget.updated", entityType: "budget", entityId: b.id, metadata: { cells: parsed.length } });
  });
}

export async function updateBudget(ctx: Ctx, id: string, input: { name: string; status: Budget["status"]; notes?: string | null }) {
  requirePermission(ctx, "budgets.manage");
  if (!input.name?.trim()) throw new ValidationError("Name the budget.", { name: "Required." });
  return withTransaction(async (tx) => {
    const [before] = await tx.select().from(budgets).where(and(eq(budgets.orgId, ctx.orgId), eq(budgets.id, id)));
    if (!before) throw new NotFoundError("The budget");
    const [row] = await tx.update(budgets).set({ name: input.name.trim(), status: input.status, notes: input.notes ?? null, updatedAt: new Date() }).where(eq(budgets.id, id)).returning();
    await audit(tx, ctx, { action: "budget.settings_updated", entityType: "budget", entityId: id, before, after: row });
    return row!;
  });
}

export async function deleteBudget(ctx: Ctx, id: string) {
  requirePermission(ctx, "budgets.manage");
  await withTransaction(async (tx) => {
    const [b] = await tx.select().from(budgets).where(and(eq(budgets.orgId, ctx.orgId), eq(budgets.id, id)));
    if (!b) throw new NotFoundError("The budget");
    await tx.delete(budgets).where(eq(budgets.id, id));
    await audit(tx, ctx, { action: "budget.deleted", entityType: "budget", entityId: id, before: { name: b.name } });
  });
}

export interface BudgetVsActualRow {
  accountId: string;
  dimensionKey: string;
  label: string;
  budget: Decimal;
  actual: Decimal;
  variance: Decimal;
  /** Variance as a percentage of budget (null when there is no budget). */
  variancePercent: Decimal | null;
}

/** Budget versus actual for a range of months within the budget's year. */
export async function budgetVsActual(db: DbOrTx, org: Org, opts: { budgetId: string; from?: string | null; to?: string | null; basis: Basis }) {
  const { budget, lines } = await getBudget(db, org.id, opts.budgetId);
  const months = budgetMonths(budget.fiscalYearStart);
  const from = opts.from && opts.from >= months[0]! ? startOfMonth(opts.from) : months[0]!;
  const lastDay = endOfMonth(months[11]!);
  const to = opts.to && opts.to <= lastDay ? endOfMonth(opts.to) : lastDay;
  const chart = await loadChart(db, org.id);
  const actuals = await monthlyActuals(db, org, from, to, opts.basis, budget.dimension);
  const names = new Map((await dimensionChoices(db, org.id, budget.dimension)).map((d) => [d.id, d.name]));
  const key = (a: string, d: string) => `${a}|${d}`;
  const agg = new Map<string, { accountId: string; dimensionKey: string; budget: Decimal; actual: Decimal }>();
  for (const l of lines) {
    if (l.periodStart < from || l.periodStart > to) continue;
    const k = key(l.accountId, l.dimensionKey);
    const v = agg.get(k) ?? { accountId: l.accountId, dimensionKey: l.dimensionKey, budget: Decimal.ZERO, actual: Decimal.ZERO };
    v.budget = v.budget.add(l.amount);
    agg.set(k, v);
  }
  for (const r of actuals) {
    const acc = chart.byId.get(r.account_id);
    if (!acc) continue;
    const dk = budget.dimension ? (r.dim ?? "") : "";
    const k = key(r.account_id, dk);
    const v = agg.get(k) ?? { accountId: r.account_id, dimensionKey: dk, budget: Decimal.ZERO, actual: Decimal.ZERO };
    v.actual = v.actual.add(creditNormal(acc.type) ? Decimal.from(r.base).neg() : Decimal.from(r.base));
    agg.set(k, v);
  }
  const order = new Map(chart.ordered.map((a, i) => [a.id, i]));
  const rows: BudgetVsActualRow[] = [...agg.values()]
    .filter((v) => !v.budget.isZero() || !v.actual.isZero())
    .sort((a, b) => (order.get(a.accountId) ?? 0) - (order.get(b.accountId) ?? 0) || a.dimensionKey.localeCompare(b.dimensionKey))
    .map((v) => {
      const acc = chart.byId.get(v.accountId)!;
      const variance = v.actual.sub(v.budget);
      return {
        accountId: v.accountId,
        dimensionKey: v.dimensionKey,
        label: `${label(acc)}${budget.dimension ? ` · ${v.dimensionKey ? (names.get(v.dimensionKey) ?? "Unknown") : "Not assigned"}` : ""}`,
        budget: v.budget,
        actual: v.actual,
        variance,
        variancePercent: v.budget.isZero() ? null : variance.mul(100).div(v.budget, 1, "half_up"),
      };
    });
  const tableRows: ReportRow[] = [];
  for (const type of ["income", "expense"] as const) {
    const group = rows.filter((r) => chart.byId.get(r.accountId)?.type === type);
    if (!group.length) continue;
    tableRows.push({ kind: "section", cells: [{ value: type === "income" ? "Income" : "Expenses" }, { value: null }, { value: null }, { value: null }, { value: null }] });
    for (const r of group) {
      const dimParam = budget.dimension ? { [budget.dimension]: r.dimensionKey || "none" } : {};
      tableRows.push({
        kind: "detail",
        level: 1,
        cells: [
          { value: r.label },
          { value: r.budget.toString() },
          { value: r.actual.toString(), href: glHref({ account: r.accountId, from, to, basis: opts.basis, ...dimParam }) },
          { value: r.variance.toString() },
          { value: r.variancePercent?.toString() ?? null },
        ],
      });
    }
    const b = Decimal.sum(group.map((r) => r.budget));
    const a = Decimal.sum(group.map((r) => r.actual));
    tableRows.push({
      kind: "subtotal",
      cells: [{ value: `Total ${type === "income" ? "income" : "expenses"}` }, { value: b.toString() }, { value: a.toString() }, { value: a.sub(b).toString() }, { value: b.isZero() ? null : a.sub(b).mul(100).div(b, 1, "half_up").toString() }],
    });
  }
  const inc = rows.filter((r) => chart.byId.get(r.accountId)?.type === "income");
  const exp = rows.filter((r) => chart.byId.get(r.accountId)?.type === "expense");
  const netBudget = Decimal.sum(inc.map((r) => r.budget)).sub(Decimal.sum(exp.map((r) => r.budget)));
  const netActual = Decimal.sum(inc.map((r) => r.actual)).sub(Decimal.sum(exp.map((r) => r.actual)));
  tableRows.push({
    kind: "total",
    cells: [{ value: "Net income" }, { value: netBudget.toString() }, { value: netActual.toString() }, { value: netActual.sub(netBudget).toString() }, { value: netBudget.isZero() ? null : netActual.sub(netBudget).mul(100).div(netBudget.abs(), 1, "half_up").toString() }],
  });
  const table: ReportTable = {
    key: "budget-vs-actual",
    title: `Budget vs actual: ${budget.name}`,
    subtitle: `${formatDate(from)} – ${formatDate(to)} · ${opts.basis === "cash" ? "Cash" : "Accrual"} basis`,
    currency: org.baseCurrency,
    columns: [
      { key: "account", label: "Account", kind: "text" },
      { key: "budget", label: "Budget", kind: "money", align: "right" },
      { key: "actual", label: "Actual", kind: "money", align: "right" },
      { key: "variance", label: "Variance", kind: "money", align: "right" },
      { key: "pct", label: "Variance %", kind: "percent", align: "right" },
    ],
    rows: tableRows,
    notes: ["Income and expenses are shown as positive amounts. Variance is actual minus budget: above budget is positive for income (good) and for expenses (over budget)."],
  };
  return { budget, from, to, rows, netBudget, netActual, table };
}
