/** Period-close checks contributed by the payroll module (see lib/ledger/close-checks.ts). */
import { and, eq, sql } from "drizzle-orm";
import { payrollImports } from "@/lib/db/schema/payroll";
import { getSystemAccountReadOnly } from "@/lib/ledger/accounts";
import { Decimal } from "@/lib/money/decimal";
import type { CloseCheck, CloseCheckResult } from "@/lib/ledger/close-checks";

export const payrollCloseChecks: CloseCheck = async (db, ctx, period) => {
  const out: CloseCheckResult[] = [];
  const pending = await db
    .select({ parsed: payrollImports.parsed })
    .from(payrollImports)
    .where(and(eq(payrollImports.orgId, ctx.orgId), eq(payrollImports.status, "previewed")));
  const inPeriod = pending.filter((p) => {
    const payDate = (p.parsed as { payDate?: string } | null)?.payDate;
    return !!payDate && payDate >= period.startDate && payDate <= period.endDate;
  });
  if (pending.length || inPeriod.length) {
    out.push({
      key: "payroll_imports_posted",
      title: "Payroll imported for the period is posted",
      status: inPeriod.length === 0 ? "pass" : "fail",
      severity: "warning",
      ...(inPeriod.length ? { detail: `${inPeriod.length} payroll import${inPeriod.length === 1 ? " is" : "s are"} waiting to be posted.`, href: "/payroll/import" } : {}),
    });
  }
  const clearing = await getSystemAccountReadOnly(db, ctx.orgId, "net_pay_clearing");
  if (clearing) {
    const res = await db.execute<{ b: string; n: number }>(sql`
      select coalesce(sum(l.base_amount), 0)::text as b, count(*)::int as n
      from journal_lines l join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
      where l.org_id = ${ctx.orgId} and l.account_id = ${clearing.id} and e.status = 'posted' and e.entry_date <= ${period.endDate}
    `);
    const row = res.rows[0];
    if (row && row.n > 0) {
      const bal = Decimal.from(row.b);
      out.push({
        key: "net_pay_cleared",
        title: "Net pay clearing is cleared",
        status: bal.isZero() ? "pass" : "fail",
        severity: "warning",
        ...(bal.isZero() ? {} : { detail: `${clearing.code} ${clearing.name} carries ${bal.neg().toString()} of net pay not yet recorded as paid.`, href: "/payroll" }),
      });
    }
  }
  return out;
};
