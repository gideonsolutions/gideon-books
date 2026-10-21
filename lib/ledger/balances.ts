/**
 * Account balances straight from posted journal lines (accrual basis). The
 * reports module builds the statements; this is the quick figure the chart
 * of accounts, the dashboard and money-account pickers show.
 */
import { sql } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";

export async function accountBalances(db: DbOrTx, orgId: string, opts: { asOf?: string; from?: string } = {}): Promise<Map<string, { base: string; txn: string; lines: number }>> {
  const res = await db.execute<{ account_id: string; base: string; txn: string; n: number }>(sql`
    select l.account_id, sum(l.base_amount)::text as base, sum(l.txn_amount)::text as txn, count(*)::int as n
    from journal_lines l join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
    where l.org_id = ${orgId} and e.status = 'posted'
      ${opts.asOf ? sql`and e.entry_date <= ${opts.asOf}` : sql``}
      ${opts.from ? sql`and e.entry_date >= ${opts.from}` : sql``}
    group by l.account_id
  `);
  return new Map(res.rows.map((r) => [r.account_id, { base: r.base, txn: r.txn, lines: r.n }]));
}
