/**
 * General ledger detail: for each account, the balance brought forward, every
 * line in the range with its entry, source and running balance, and the
 * balance carried forward. Every other report's figures drill down to this.
 */
import { sql } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import type { Org } from "@/lib/context";
import { Decimal } from "@/lib/money/decimal";
import { formatDate } from "@/lib/money/format";
import { sourceHref } from "@/lib/web/links";
import { label, loadChart, type ReportAccount } from "./accounts";
import { filterSql, ledgerRows } from "./ledger";
import { hasFilters, type Basis, type LineFilters } from "./scope";
import type { ReportRow, ReportTable } from "./table";

export interface GlLine {
  lineId: string;
  entryId: string;
  entryNumber: number | null;
  date: string;
  kind: string;
  sourceType: string | null;
  sourceId: string | null;
  sourceRef: string | null;
  contactId: string | null;
  contactName: string | null;
  description: string;
  currency: string;
  txnAmount: string;
  amount: Decimal;
  running: Decimal;
  recognized: boolean;
}

export interface GlAccount {
  account: ReportAccount;
  opening: Decimal;
  debits: Decimal;
  credits: Decimal;
  closing: Decimal;
  lineCount: number;
  lines: GlLine[];
}

export interface GeneralLedger {
  accounts: GlAccount[];
  /** Lines across all accounts in the range (for pagination). */
  totalLines: number;
  page: number;
  pageSize: number;
  table: ReportTable;
}

export async function generalLedger(
  db: DbOrTx,
  org: Org,
  opts: { from?: string | null; to: string; basis: Basis; filters?: LineFilters; page?: number; pageSize?: number | null },
): Promise<GeneralLedger> {
  const filters = opts.filters ?? {};
  const chart = await loadChart(db, org.id);
  const from = opts.from ?? null;
  const lr = ledgerRows(org.id, opts.basis);
  const summary = await db.execute<{ account_id: string; opening: string; debits: string; credits: string; n: number }>(sql`
    select lr.account_id,
      coalesce(sum(lr.base_amount) filter (where ${from ? sql`lr.entry_date < ${from}` : sql`false`}), 0)::text as opening,
      coalesce(sum(lr.base_amount) filter (where lr.base_amount > 0 ${from ? sql`and lr.entry_date >= ${from}` : sql``}), 0)::text as debits,
      coalesce(-sum(lr.base_amount) filter (where lr.base_amount < 0 ${from ? sql`and lr.entry_date >= ${from}` : sql``}), 0)::text as credits,
      (count(*) filter (where ${from ? sql`lr.entry_date >= ${from}` : sql`true`}))::int as n
    from (${lr}) lr
    where ${filterSql(filters)} and lr.entry_date <= ${opts.to}
    group by lr.account_id
  `);
  const sums = new Map(summary.rows.map((r) => [r.account_id, r]));
  const pageSize = opts.pageSize === null ? null : Math.min(Math.max(opts.pageSize ?? 200, 1), 2000);
  const page = Math.max(opts.page ?? 1, 1);
  const totalLines = summary.rows.reduce((s, r) => s + r.n, 0);
  const lines = await db.execute<{
    line_id: string;
    entry_id: string;
    entry_number: number | null;
    entry_date: string;
    kind: string;
    source_type: string | null;
    source_id: string | null;
    source_ref: string | null;
    contact_id: string | null;
    contact_name: string | null;
    description: string | null;
    entry_description: string;
    currency: string;
    txn_amount: string;
    base_amount: string;
    account_id: string;
    running: string;
    recognized: boolean;
  }>(sql`
    with scoped as (
      select lr.*, a.code
      from (${lr}) lr
      join accounts a on a.org_id = ${org.id} and a.id = lr.account_id
      where ${filterSql(filters)} and lr.entry_date <= ${opts.to}
    ),
    opening as (
      select account_id, sum(base_amount) as ob from scoped ${from ? sql`where entry_date < ${from}` : sql`where false`} group by account_id
    )
    select s.line_id, s.entry_id, s.entry_number, s.entry_date, s.kind, s.source_type, s.source_id, s.source_ref,
           s.contact_id, c.display_name as contact_name, s.description, s.entry_description, s.currency,
           s.txn_amount::text, s.base_amount::text, s.account_id, s.recognized,
           (coalesce(o.ob, 0) + sum(s.base_amount) over (partition by s.account_id order by s.entry_date, s.entry_number nulls last, s.line_id rows unbounded preceding))::text as running
    from scoped s
    left join opening o on o.account_id = s.account_id
    left join contacts c on c.org_id = ${org.id} and c.id = s.contact_id
    ${from ? sql`where s.entry_date >= ${from}` : sql``}
    order by s.code, s.entry_date, s.entry_number nulls last, s.line_id
    ${pageSize ? sql`limit ${pageSize} offset ${(page - 1) * pageSize}` : sql``}
  `);
  const accountsOut: GlAccount[] = [];
  const byId = new Map<string, GlAccount>();
  for (const a of chart.ordered) {
    const s = sums.get(a.id);
    if (!s) continue;
    const opening = Decimal.from(s.opening);
    const debits = Decimal.from(s.debits);
    const credits = Decimal.from(s.credits);
    if (opening.isZero() && s.n === 0) continue;
    const ga: GlAccount = { account: a, opening, debits, credits, closing: opening.add(debits).sub(credits), lineCount: s.n, lines: [] };
    accountsOut.push(ga);
    byId.set(a.id, ga);
  }
  for (const r of lines.rows) {
    byId.get(r.account_id)?.lines.push({
      lineId: r.line_id,
      entryId: r.entry_id,
      entryNumber: r.entry_number,
      date: r.entry_date,
      kind: r.kind,
      sourceType: r.source_type,
      sourceId: r.source_id,
      sourceRef: r.source_ref,
      contactId: r.contact_id,
      contactName: r.contact_name,
      description: r.description || r.entry_description,
      currency: r.currency,
      txnAmount: r.txn_amount,
      amount: Decimal.from(r.base_amount),
      running: Decimal.from(r.running),
      recognized: r.recognized,
    });
  }
  return { accounts: accountsOut, totalLines, page, pageSize: pageSize ?? totalLines, table: glTable(org, accountsOut, { from, to: opts.to, basis: opts.basis, filtered: hasFilters(filters) }) };
}

function glTable(org: Org, accts: GlAccount[], o: { from: string | null; to: string; basis: Basis; filtered: boolean }): ReportTable {
  const rows: ReportRow[] = [];
  const blank = { value: null };
  for (const ga of accts) {
    rows.push({ kind: "section", cells: [{ value: label(ga.account) }, blank, blank, blank, blank, blank, blank, blank] });
    if (o.from) rows.push({ kind: "detail", level: 1, cells: [{ value: "Balance brought forward" }, { value: o.from }, blank, blank, blank, blank, blank, { value: ga.opening.toString() }] });
    for (const l of ga.lines) {
      const href = sourceHref("", l.sourceType, l.sourceId) ?? `/accounting/journal/${l.entryId}`;
      rows.push({
        kind: "detail",
        level: 1,
        cells: [
          { value: l.recognized ? `${l.description} (cash-basis recognition)` : l.description },
          { value: l.date },
          { value: l.entryNumber ? `#${l.entryNumber}` : null, href: `/accounting/journal/${l.entryId}` },
          { value: [l.kind.replace(/_/g, " "), l.sourceRef].filter(Boolean).join(" "), href },
          { value: l.contactName },
          { value: l.amount.isPositive() ? l.amount.toString() : null },
          { value: l.amount.isNegative() ? l.amount.neg().toString() : null },
          { value: l.running.toString() },
        ],
      });
    }
    rows.push({
      kind: "subtotal",
      level: 1,
      cells: [{ value: `Total ${label(ga.account)}` }, blank, blank, blank, blank, { value: ga.debits.toString() }, { value: ga.credits.toString() }, { value: ga.closing.toString() }],
    });
  }
  const basisText = o.basis === "cash" ? "Cash basis" : "Accrual basis";
  return {
    key: "general-ledger",
    title: "General ledger",
    subtitle: `${o.from ? `${formatDate(o.from)} – ` : "Through "}${formatDate(o.to)} · ${basisText}`,
    currency: org.baseCurrency,
    columns: [
      { key: "description", label: "Description", kind: "text" },
      { key: "date", label: "Date", kind: "date" },
      { key: "entry", label: "Entry", kind: "text" },
      { key: "source", label: "Source", kind: "text" },
      { key: "contact", label: "Contact", kind: "text" },
      { key: "debit", label: "Debit", kind: "money", align: "right" },
      { key: "credit", label: "Credit", kind: "money", align: "right" },
      { key: "balance", label: "Balance", kind: "money", align: "right" },
    ],
    rows,
    notes: [
      "Balances are in the base currency, debits positive. Lines marked “cash-basis recognition” are the share of an invoice or bill recognized when it was paid.",
      ...(o.filtered ? ["Filtered: only lines matching the filters are included."] : []),
    ],
  };
}
