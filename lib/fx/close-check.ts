/** Period-close check: foreign-currency balances have been revalued at period end. */
import { and, eq, sql } from "drizzle-orm";
import { journalEntries } from "@/lib/db/schema/ledger";
import type { CloseCheck } from "@/lib/ledger/close-checks";

export const fxCloseChecks: CloseCheck = async (db, ctx, period) => {
  const base = ctx.org.baseCurrency;
  const res = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from (
      select 1
      from journal_lines l
      join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
      join accounts a on a.org_id = l.org_id and a.id = l.account_id
      where l.org_id = ${ctx.orgId} and e.status = 'posted' and e.entry_date <= ${period.endDate}
        and l.currency <> ${base}
        and (a.control in ('receivables','payables','customer_deposits','vendor_prepayments') or a.currency is not null)
      group by l.account_id, l.open_item_id, l.currency
      having sum(l.txn_amount) <> 0
    ) x
  `);
  const foreign = res.rows[0]?.n ?? 0;
  if (foreign === 0) return [];
  const [reval] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(journalEntries)
    .where(and(eq(journalEntries.orgId, ctx.orgId), eq(journalEntries.kind, "fx_revaluation"), eq(journalEntries.entryDate, period.endDate)));
  const done = (reval?.n ?? 0) > 0;
  return [
    {
      key: "fx_revalued",
      title: "Foreign-currency balances revalued at period end",
      status: done ? "pass" : "fail",
      severity: "warning",
      ...(done ? {} : { detail: `${foreign} foreign-currency balance${foreign === 1 ? " is" : "s are"} carried at historical rates.`, href: "/settings/currencies" }),
    },
  ];
};
