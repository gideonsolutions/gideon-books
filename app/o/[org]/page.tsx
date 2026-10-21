import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { dashboardData } from "@/lib/dashboard";
import { can } from "@/lib/context";
import { todayIn } from "@/lib/dates";
import { formatDateTime, formatMoney } from "@/lib/money/format";
import { Alert, Badge, Card, LinkButton, Money, PageHeader, Stat, Table, Td, Th } from "@/components/ui";
import { NetIncomeChart } from "@/components/client/net-income-chart";
import { Decimal } from "@/lib/money/decimal";

export const metadata = { title: "Dashboard" };

export default async function Dashboard({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await orgCtx(org);
  const today = todayIn(ctx.org.timezone);
  const d = await dashboardData(getDb(), ctx, today);
  const cur = ctx.org.baseCurrency;
  const base = `/o/${org}`;
  const fmt = (v: string) => formatMoney(v, cur);
  return (
    <>
      <PageHeader
        title={ctx.org.name}
        description={`As of ${today}. Figures are on the accrual basis in ${cur}.`}
        actions={
          <>
            {can(ctx, "sales.manage") && <LinkButton href={`${base}/sales/invoices/new`}>New invoice</LinkButton>}
            {can(ctx, "purchases.manage") && (
              <LinkButton variant="secondary" href={`${base}/purchases/bills/new`}>
                Enter a bill
              </LinkButton>
            )}
          </>
        }
      />
      {!ctx.org.onboardingCompletedAt && !ctx.org.isDemo && can(ctx, "org.settings") && (
        <div className="mb-6">
          <Alert tone="info" title="Finish setting up">
            Add your opening balances, bank accounts and the people who work in these books.{" "}
            <Link href={`${base}/onboarding`} className="font-medium underline">
              Continue setup
            </Link>
          </Alert>
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Cash" value={fmt(d.cashTotal)} hint="Bank, cash and clearing accounts" href={`${base}/banking`} />
        <Stat
          label="Owed to you"
          value={fmt(d.ar.total)}
          hint={d.ar.overdueCount > 0 ? `${fmt(d.ar.overdue)} overdue on ${d.ar.overdueCount} invoice${d.ar.overdueCount === 1 ? "" : "s"}` : "Nothing overdue"}
          tone={d.ar.overdueCount > 0 ? "warning" : "default"}
          href={`${base}/reports/ar-aging?asOf=${today}`}
        />
        <Stat
          label="You owe"
          value={fmt(d.ap.total)}
          hint={Decimal.from(d.ap.overdue).isZero() ? `${fmt(d.ap.dueSoon)} due within 7 days` : `${fmt(d.ap.overdue)} overdue`}
          tone={Decimal.from(d.ap.overdue).isZero() ? "default" : "danger"}
          href={`${base}/reports/ap-aging?asOf=${today}`}
        />
        <Stat
          label="Net income, fiscal year to date"
          value={fmt(d.ytd)}
          hint={`This month ${fmt(d.thisMonth.net)}`}
          tone={Decimal.from(d.ytd).isNegative() ? "danger" : "good"}
          href={`${base}/reports/profit-and-loss?from=${d.fyStart}&to=${today}`}
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          <Card title="Net income by month" actions={<Link className="text-sm text-brand-700 hover:underline" href={`${base}/reports/profit-and-loss?from=${d.series[0]!.month}-01&to=${today}&compare=months`}>Profit and loss</Link>}>
            <NetIncomeChart data={d.series} currency={cur} />
            <details className="mt-3">
              <summary className="cursor-pointer text-sm text-brand-700">Show the figures</summary>
              <Table className="mt-2">
                <thead>
                  <tr>
                    <Th>Month</Th>
                    <Th align="right">Income</Th>
                    <Th align="right">Expenses</Th>
                    <Th align="right">Net</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {d.series.map((m) => (
                    <tr key={m.month}>
                      <Td>{m.month}</Td>
                      <Td align="right">
                        <Money amount={m.income} currency={cur} />
                      </Td>
                      <Td align="right">
                        <Money amount={m.expenses} currency={cur} />
                      </Td>
                      <Td align="right">
                        <Money amount={m.net} currency={cur} />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </details>
          </Card>
          <Card title="Bank and card balances" padded={false}>
            {d.cash.length === 0 ? (
              <p className="p-4 text-sm text-slate-500">
                No bank accounts yet.{" "}
                <Link href={`${base}/accounting/accounts/new`} className="text-brand-700 hover:underline">
                  Add one
                </Link>
                .
              </p>
            ) : (
              <Table className="rounded-none border-0 shadow-none">
                <tbody className="divide-y divide-slate-100">
                  {d.cash.map((a) => (
                    <tr key={a.id}>
                      <Td>
                        <Link href={`${base}/banking/accounts/${a.id}`} className="font-medium text-slate-900 hover:text-brand-700">
                          {a.name}
                        </Link>
                        <span className="ml-2 text-xs text-slate-500">{a.subtype.replace("_", " ")}</span>
                      </Td>
                      <Td align="right">
                        <Money amount={a.base} currency={cur} />
                        {a.currency && (
                          <div className="text-xs text-slate-500">
                            <Money amount={a.txn} currency={a.currency} />
                          </div>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>
        <div className="space-y-6">
          <Card title="Needs attention">
            {d.actions.length === 0 ? (
              <p className="text-sm text-slate-600">Nothing is waiting. </p>
            ) : (
              <ul className="space-y-2">
                {d.actions.map((a) => (
                  <li key={a.key}>
                    <Link href={`${base}${a.href}`} className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-slate-50">
                      <span className="text-slate-800">{a.label}</span>
                      <Badge tone={a.tone === "danger" ? "red" : a.tone === "warning" ? "amber" : "blue"}>{a.count}</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Recent activity">
            {d.recent.length === 0 ? (
              <p className="text-sm text-slate-500">No activity yet.</p>
            ) : (
              <ol className="space-y-2.5">
                {d.recent.map((r) => (
                  <li key={r.id} className="text-sm">
                    <div className="text-slate-800">{r.action.replace(/[._]/g, " ")}</div>
                    <div className="text-xs text-slate-500">
                      {r.actor_label} · {formatDateTime(r.created_at, ctx.org.timezone)}
                    </div>
                  </li>
                ))}
              </ol>
            )}
            {can(ctx, "audit.read") && (
              <Link href={`${base}/audit`} className="mt-3 inline-block text-sm text-brand-700 hover:underline">
                Full audit log
              </Link>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
