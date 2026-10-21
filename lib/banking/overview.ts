/** The banking overview: each money account with its book balance, reconciliation, review queue and feed. */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import { accounts, bankAccountDetails } from "@/lib/db/schema/ledger";
import { integrationConnections } from "@/lib/db/schema/core";
import { bankFeedAccounts, bankImportBatches, bankTransactions, reconciliations } from "@/lib/db/schema/banking";
import type { Ctx } from "@/lib/context";
import { MONEY_SUBTYPES, reviewCondition } from "./common";


export interface MoneyAccountSummary {
  id: string;
  code: string;
  name: string;
  subtype: string;
  currency: string;
  isArchived: boolean;
  institution: string | null;
  mask: string | null;
  bookBalance: string;
  toReview: number;
  lastReconciled: { statementDate: string; statementBalance: string } | null;
  inProgressReconciliationId: string | null;
  feed: { name: string; provider: string; status: string; lastSyncedAt: Date | null; lastError: string | null } | null;
  lastImportAt: Date | null;
}

export async function moneyAccountSummaries(db: DbOrTx, ctx: Ctx, opts: { includeArchived?: boolean } = {}): Promise<MoneyAccountSummary[]> {
  const rows = await db
    .select({ a: accounts, d: bankAccountDetails })
    .from(accounts)
    .leftJoin(bankAccountDetails, and(eq(bankAccountDetails.orgId, accounts.orgId), eq(bankAccountDetails.accountId, accounts.id)))
    .where(and(eq(accounts.orgId, ctx.orgId), inArray(accounts.subtype, [...MONEY_SUBTYPES])))
    .orderBy(asc(accounts.code));
  const list = rows.filter((r) => opts.includeArchived || !r.a.isArchived);
  if (!list.length) return [];
  const ids = list.map((r) => r.a.id);
  const balances = await db.execute<{ account_id: string; amount: string }>(sql`
    select l.account_id, sum(case when a.currency is not null then l.txn_amount else l.base_amount end)::text as amount
    from journal_lines l
    join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
    join accounts a on a.org_id = l.org_id and a.id = l.account_id
    where l.org_id = ${ctx.orgId} and e.status = 'posted' and l.account_id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
    group by l.account_id
  `);
  const bal = new Map(balances.rows.map((b) => [b.account_id, b.amount]));
  const review = await db
    .select({ accountId: bankTransactions.accountId, n: sql<number>`count(*)::int` })
    .from(bankTransactions)
    .where(and(eq(bankTransactions.orgId, ctx.orgId), inArray(bankTransactions.accountId, ids), reviewCondition()))
    .groupBy(bankTransactions.accountId);
  const reviewBy = new Map(review.map((r) => [r.accountId, r.n]));
  const recs = await db
    .select()
    .from(reconciliations)
    .where(and(eq(reconciliations.orgId, ctx.orgId), inArray(reconciliations.accountId, ids), inArray(reconciliations.status, ["completed", "in_progress"])));
  const feeds = await db
    .select({ fa: bankFeedAccounts, c: integrationConnections })
    .from(bankFeedAccounts)
    .innerJoin(integrationConnections, and(eq(integrationConnections.orgId, bankFeedAccounts.orgId), eq(integrationConnections.id, bankFeedAccounts.connectionId)))
    .where(and(eq(bankFeedAccounts.orgId, ctx.orgId), inArray(bankFeedAccounts.linkedAccountId, ids)));
  const imports = await db
    .select({ accountId: bankImportBatches.accountId, at: sql<Date>`max(${bankImportBatches.createdAt})` })
    .from(bankImportBatches)
    .where(and(eq(bankImportBatches.orgId, ctx.orgId), inArray(bankImportBatches.accountId, ids), eq(bankImportBatches.status, "completed")))
    .groupBy(bankImportBatches.accountId);
  return list.map(({ a, d }) => {
    const completed = recs.filter((r) => r.accountId === a.id && r.status === "completed").sort((x, y) => (x.statementDate < y.statementDate ? 1 : -1))[0];
    const inProgress = recs.find((r) => r.accountId === a.id && r.status === "in_progress");
    const feed = feeds.find((f) => f.fa.linkedAccountId === a.id);
    const imp = imports.find((i) => i.accountId === a.id);
    return {
      id: a.id,
      code: a.code,
      name: a.name,
      subtype: a.subtype,
      currency: a.currency ?? ctx.org.baseCurrency,
      isArchived: a.isArchived,
      institution: d?.institution ?? null,
      mask: d?.mask ?? null,
      bookBalance: bal.get(a.id) ?? "0",
      toReview: reviewBy.get(a.id) ?? 0,
      lastReconciled: completed ? { statementDate: completed.statementDate, statementBalance: completed.statementBalance } : null,
      inProgressReconciliationId: inProgress?.id ?? null,
      feed: feed ? { name: feed.fa.name, provider: feed.c.provider, status: feed.c.status, lastSyncedAt: feed.fa.lastSyncedAt ?? feed.c.lastSyncedAt, lastError: feed.c.lastError } : null,
      lastImportAt: imp?.at ? new Date(imp.at) : null,
    };
  });
}

/** The account register: posted lines on the account with a running balance, and whether each is matched or cleared. */
export async function accountRegister(db: DbOrTx, ctx: Ctx, accountId: string, opts: { from?: string; to?: string; limit?: number } = {}) {
  const res = await db.execute<{
    line_id: string;
    entry_id: string;
    entry_number: number | null;
    entry_date: string;
    kind: string;
    description: string;
    contact_name: string | null;
    amount: string;
    running: string;
    matched: boolean;
    cleared_through: string | null;
  }>(sql`
    with lines as (
      select l.id as line_id, e.id as entry_id, e.entry_number, e.entry_date, e.kind, l.line_no,
             coalesce(nullif(l.description, ''), e.description) as description, c.display_name as contact_name,
             (case when a.currency is not null then l.txn_amount else l.base_amount end) as amount
      from journal_lines l
      join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
      join accounts a on a.org_id = l.org_id and a.id = l.account_id
      left join contacts c on c.org_id = l.org_id and c.id = l.contact_id
      where l.org_id = ${ctx.orgId} and l.account_id = ${accountId} and e.status = 'posted'
        ${opts.to ? sql`and e.entry_date <= ${opts.to}` : sql``}
    ), running as (
      select *, sum(amount) over (order by entry_date, entry_number, line_no rows unbounded preceding) as running from lines
    )
    select r.line_id, r.entry_id, r.entry_number, r.entry_date, r.kind, r.description, r.contact_name, r.amount::text, r.running::text,
           exists (select 1 from bank_match_items mi where mi.org_id = ${ctx.orgId} and mi.journal_line_id = r.line_id and mi.active) as matched,
           (select rc.statement_date::text from reconciliation_lines rl join reconciliations rc on rc.org_id = rl.org_id and rc.id = rl.reconciliation_id
             where rl.org_id = ${ctx.orgId} and rl.journal_line_id = r.line_id and rl.active and rc.status = 'completed' limit 1) as cleared_through
    from running r
    ${opts.from ? sql`where r.entry_date >= ${opts.from}` : sql``}
    order by r.entry_date desc, r.entry_number desc, r.line_id
    limit ${opts.limit ?? 300}
  `);
  return res.rows;
}
