/**
 * Period-close checks from banking: every money account with activity is
 * reconciled through the period end, and no bank transaction dated in the
 * period is still waiting for review.
 */
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { bankTransactions, reconciliations } from "@/lib/db/schema/banking";
import type { CloseCheck } from "@/lib/ledger/close-checks";
import { MONEY_SUBTYPES, reviewCondition } from "./common";


export const bankingCloseChecks: CloseCheck = async (db, ctx, period) => {
  const active = await db.execute<{ id: string; code: string; name: string }>(sql`
    select distinct a.id, a.code, a.name
    from accounts a
    join journal_lines l on l.org_id = a.org_id and l.account_id = a.id
    join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id and e.status = 'posted' and e.entry_date <= ${period.endDate}
    where a.org_id = ${ctx.orgId} and a.subtype in (${sql.join(
      MONEY_SUBTYPES.filter((s) => s !== "clearing").map((s) => sql`${s}`),
      sql`, `,
    )})
  `);
  const results = [];
  if (active.rows.length) {
    const recs = await db
      .select({ accountId: reconciliations.accountId, through: sql<string>`max(${reconciliations.statementDate})::text` })
      .from(reconciliations)
      .where(and(eq(reconciliations.orgId, ctx.orgId), eq(reconciliations.status, "completed"), inArray(reconciliations.accountId, active.rows.map((r) => r.id))))
      .groupBy(reconciliations.accountId);
    const through = new Map(recs.map((r) => [r.accountId, r.through]));
    const behind = active.rows.filter((a) => !through.get(a.id) || through.get(a.id)! < period.endDate);
    results.push({
      key: "bank_reconciled",
      title: "Bank and credit-card accounts reconciled through the period end",
      status: behind.length ? ("fail" as const) : ("pass" as const),
      severity: "warning" as const,
      ...(behind.length
        ? {
            detail: behind.map((a) => `${a.code} ${a.name}${through.get(a.id) ? ` (reconciled to ${through.get(a.id)})` : " (never reconciled)"}`).join("; "),
            href: "/banking/reconciliations",
          }
        : {}),
    });
  }
  const [pending] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(bankTransactions)
    .where(and(eq(bankTransactions.orgId, ctx.orgId), gte(bankTransactions.postedDate, period.startDate), lte(bankTransactions.postedDate, period.endDate), reviewCondition()));
  const [any] = await db.select({ n: sql<number>`count(*)::int` }).from(bankTransactions).where(eq(bankTransactions.orgId, ctx.orgId));
  if ((any?.n ?? 0) > 0) {
    results.push({
      key: "bank_reviewed",
      title: "No bank transactions dated in the period waiting for review",
      status: (pending?.n ?? 0) === 0 ? ("pass" as const) : ("fail" as const),
      severity: "warning" as const,
      ...((pending?.n ?? 0) > 0 ? { detail: `${pending!.n} bank transaction${pending!.n === 1 ? " is" : "s are"} not yet matched, categorized or excluded.`, href: "/banking/transactions" } : {}),
    });
  }
  return results;
};
