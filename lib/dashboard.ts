/**
 * The dashboard's figures: cash, receivables and payables (with what is
 * overdue or due soon), income by month, and the things waiting for someone.
 * Read-only; every figure links to the report or list behind it.
 */
import { sql } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import type { Ctx } from "@/lib/context";
import { Decimal } from "@/lib/money/decimal";
import { addDays, addMonths, endOfMonth, startOfMonth } from "@/lib/dates";
import { fiscalYearStart } from "@/lib/ledger/periods";

export interface MonthFigure {
  month: string;
  income: string;
  expenses: string;
  net: string;
}

export interface ActionItem {
  key: string;
  label: string;
  count: number;
  href: string;
  tone: "warning" | "danger" | "info";
}

async function tableExists(db: DbOrTx, name: string): Promise<boolean> {
  const r = await db.execute<{ t: string | null }>(sql`select to_regclass(${name})::text as t`);
  return !!r.rows[0]?.t;
}

export async function dashboardData(db: DbOrTx, ctx: Ctx, today: string) {
  const orgId = ctx.orgId;
  const cash = await db.execute<{ id: string; code: string; name: string; subtype: string; currency: string | null; base: string; txn: string }>(sql`
    select a.id, a.code, a.name, a.subtype, a.currency,
           coalesce(sum(l.base_amount) filter (where e.status = 'posted'), 0)::text as base,
           coalesce(sum(l.txn_amount) filter (where e.status = 'posted'), 0)::text as txn
    from accounts a
    left join journal_lines l on l.org_id = a.org_id and l.account_id = a.id
    left join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
    where a.org_id = ${orgId} and a.subtype in ('bank','cash','clearing','credit_card') and not a.is_archived
    group by a.id order by a.code
  `);

  const openItems = await db.execute<{ side: string; total: string; overdue: string; overdue_n: number; due_soon: string; due_soon_n: number }>(sql`
    with items as (
      select a.control, l.open_item_id, sum(l.base_amount) as bal
      from journal_lines l
      join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
      join accounts a on a.org_id = l.org_id and a.id = l.account_id
      where l.org_id = ${orgId} and e.status = 'posted' and a.control in ('receivables','payables')
      group by a.control, l.open_item_id
      having sum(l.base_amount) <> 0
    )
    select i.control as side,
           coalesce(sum(i.bal), 0)::text as total,
           coalesce(sum(i.bal) filter (where d.due_date < ${today}), 0)::text as overdue,
           count(*) filter (where d.due_date < ${today})::int as overdue_n,
           coalesce(sum(i.bal) filter (where d.due_date >= ${today} and d.due_date <= ${addDays(today, 7)}), 0)::text as due_soon,
           count(*) filter (where d.due_date >= ${today} and d.due_date <= ${addDays(today, 7)})::int as due_soon_n
    from items i
    left join documents d on d.org_id = ${orgId} and d.id = i.open_item_id
    group by i.control
  `);
  const ar = openItems.rows.find((r) => r.side === "receivables");
  const ap = openItems.rows.find((r) => r.side === "payables");

  const from = startOfMonth(addMonths(today, -11));
  const months = await db.execute<{ month: string; income: string; expenses: string }>(sql`
    select to_char(date_trunc('month', e.entry_date), 'YYYY-MM') as month,
           coalesce(-sum(l.base_amount) filter (where a.type = 'income'), 0)::text as income,
           coalesce(sum(l.base_amount) filter (where a.type = 'expense'), 0)::text as expenses
    from journal_lines l
    join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
    join accounts a on a.org_id = l.org_id and a.id = l.account_id
    where l.org_id = ${orgId} and e.status = 'posted' and a.type in ('income','expense')
      and e.entry_date >= ${from} and e.entry_date <= ${endOfMonth(today)}
    group by 1 order by 1
  `);
  const byMonth = new Map(months.rows.map((m) => [m.month, m]));
  const series: MonthFigure[] = [];
  for (let i = 11; i >= 0; i--) {
    const m = addMonths(startOfMonth(today), -i).slice(0, 7);
    const r = byMonth.get(m);
    const income = Decimal.from(r?.income ?? "0");
    const expenses = Decimal.from(r?.expenses ?? "0");
    series.push({ month: m, income: income.toString(), expenses: expenses.toString(), net: income.sub(expenses).toString() });
  }
  const fyStart = fiscalYearStart(today, ctx.org.fiscalYearStartMonth);
  const ytd = series.filter((s) => `${s.month}-01` >= fyStart).reduce((acc, s) => acc.add(s.net), Decimal.ZERO);

  // Things waiting for someone.
  const actions: ActionItem[] = [];
  const counts = await db.execute<{ drafts: number; journal_drafts: number; failed_jobs: number; open_past_periods: number }>(sql`
    select
      (select count(*) from documents where org_id = ${orgId} and status = 'draft' and kind in ('invoice','bill','credit_note','vendor_credit','expense','sales_receipt'))::int as drafts,
      (select count(*) from journal_entries where org_id = ${orgId} and status = 'draft')::int as journal_drafts,
      (select count(*) from jobs where org_id = ${orgId} and status in ('dead'))::int as failed_jobs,
      (select count(*) from fiscal_periods where org_id = ${orgId} and status = 'open' and end_date < ${startOfMonth(addMonths(today, -1))})::int as open_past_periods
  `);
  const c = counts.rows[0]!;
  if ((ar?.overdue_n ?? 0) > 0) actions.push({ key: "overdue_invoices", label: "Overdue invoices to chase", count: ar!.overdue_n, href: "/sales/invoices?status=overdue", tone: "danger" });
  if ((ap?.due_soon_n ?? 0) > 0) actions.push({ key: "bills_due", label: "Bills due within 7 days", count: ap!.due_soon_n, href: "/purchases/bills?status=open", tone: "warning" });
  if ((ap?.overdue_n ?? 0) > 0) actions.push({ key: "bills_overdue", label: "Overdue bills", count: ap!.overdue_n, href: "/purchases/bills?status=open", tone: "danger" });
  if (c.drafts > 0) actions.push({ key: "drafts", label: "Draft documents not yet issued", count: c.drafts, href: "/sales/invoices?status=draft", tone: "info" });
  if (c.journal_drafts > 0) actions.push({ key: "journal_drafts", label: "Draft journal entries", count: c.journal_drafts, href: "/accounting/journal?status=draft", tone: "info" });
  if (c.open_past_periods > 0) actions.push({ key: "periods", label: "Past periods still open", count: c.open_past_periods, href: "/accounting/periods", tone: "info" });
  if (c.failed_jobs > 0) actions.push({ key: "jobs", label: "Background jobs that failed", count: c.failed_jobs, href: "/jobs?status=dead", tone: "danger" });
  if (await tableExists(db, "bank_transactions")) {
    const r = await db.execute<{ n: number }>(sql`select count(*)::int as n from bank_transactions where org_id = ${orgId} and status = 'unreviewed'`).catch(() => ({ rows: [{ n: 0 }] }));
    const n = r.rows[0]?.n ?? 0;
    if (n > 0) actions.unshift({ key: "bank_review", label: "Bank transactions to review", count: n, href: "/banking/transactions", tone: "warning" });
  }

  const recent = await db.execute<{ id: number; action: string; actor_label: string; created_at: Date; entity_type: string | null; entity_id: string | null }>(sql`
    select id, action, actor_label, created_at, entity_type, entity_id from audit_events where org_id = ${orgId} order by id desc limit 8
  `);

  const cashTotal = Decimal.sum(cash.rows.filter((r) => r.subtype !== "credit_card").map((r) => r.base));
  return {
    cash: cash.rows,
    cashTotal: cashTotal.toString(),
    ar: { total: ar?.total ?? "0", overdue: ar?.overdue ?? "0", overdueCount: ar?.overdue_n ?? 0 },
    ap: { total: Decimal.from(ap?.total ?? "0").neg().toString(), dueSoon: Decimal.from(ap?.due_soon ?? "0").neg().toString(), overdue: Decimal.from(ap?.overdue ?? "0").neg().toString() },
    series,
    thisMonth: series[series.length - 1]!,
    ytd: ytd.toString(),
    fyStart,
    actions,
    recent: recent.rows,
  };
}
