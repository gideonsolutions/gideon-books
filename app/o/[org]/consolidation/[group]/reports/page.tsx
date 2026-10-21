import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { groupContext } from "@/lib/consolidation/groups";
import { consolidate, statementRows } from "@/lib/consolidation/report";
import { orgCtx, requireUser } from "@/lib/web/session";
import { dateParam, readParams, type SearchParams } from "@/lib/web/params";
import { todayIn } from "@/lib/dates";
import { Decimal } from "@/lib/money/decimal";
import { Alert, Badge, Card, FilterBar, FilterField, LinkButton, Money, PageHeader, Table, Td, Th, inputClass, buttonClass } from "@/components/ui";

export const metadata = { title: "Consolidated statements" };

const VIEWS = { trial_balance: "Trial balance", balance_sheet: "Balance sheet", profit_and_loss: "Profit and loss" } as const;
type View = keyof typeof VIEWS;

export default async function ConsolidatedReports({ params, searchParams }: { params: Promise<{ org: string; group: string }>; searchParams: SearchParams }) {
  const { org, group: groupId } = await params;
  const sp = await readParams(searchParams);
  const ctx = await orgCtx(org);
  const user = await requireUser();
  const db = getDb();
  const g = await groupContext(db, { userId: user.id, label: user.email }, groupId);
  const to = dateParam(sp.to) ?? todayIn(ctx.org.timezone);
  const from = dateParam(sp.from) ?? `${to.slice(0, 4)}-01-01`;
  const view: View = sp.view && sp.view in VIEWS ? (sp.view as View) : "balance_sheet";
  const r = await consolidate(db, g, from, to);
  const rows = statementRows(r, view);
  const rc = r.reportingCurrency;
  const q = new URLSearchParams({ from, to, view }).toString();
  // Display: debit-normal types show debits positive; others show credits positive.
  const show = (type: string, v: string) => (type === "asset" || type === "expense" ? v : Decimal.from(v).neg().toString());
  const drill = (memberId: string, gaId: string) => `/o/${org}/consolidation/${groupId}/drill?member=${memberId}&ga=${gaId}&from=${from}&to=${to}`;
  const sections: { title: string; types: string[] }[] =
    view === "balance_sheet"
      ? [
          { title: "Assets", types: ["asset"] },
          { title: "Liabilities", types: ["liability"] },
          { title: "Equity", types: ["equity"] },
        ]
      : view === "profit_and_loss"
        ? [
            { title: "Income", types: ["income"] },
            { title: "Expenses", types: ["expense"] },
          ]
        : [{ title: "All accounts (debits positive)", types: ["asset", "liability", "equity", "income", "expense"] }];
  return (
    <>
      <PageHeader
        title={`${g.group.name}: ${VIEWS[view]}`}
        back={{ href: `/o/${org}/consolidation/${groupId}`, label: g.group.name }}
        description={`${from} to ${to}, in ${rc}. Accrual basis, posted entries only. Balance sheet accounts at closing rates; income and expense at average rates; the difference is the translation adjustment.`}
        actions={
          <a className={buttonClass("secondary")} href={`/o/${org}/consolidation/${groupId}/reports/export?${q}`}>
            Export CSV
          </a>
        }
      />
      <FilterBar>
        <FilterField label="From">
          <input type="date" name="from" defaultValue={from} className={inputClass} />
        </FilterField>
        <FilterField label="To">
          <input type="date" name="to" defaultValue={to} className={inputClass} />
        </FilterField>
        <FilterField label="Statement">
          <select name="view" defaultValue={view} className={inputClass}>
            {Object.entries(VIEWS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </FilterField>
      </FilterBar>
      <div className="mb-4 space-y-2">
        {r.warnings.map((w, i) => (
          <Alert key={i} tone="warning">
            {w}
          </Alert>
        ))}
        {r.blockers.length > 0 && (
          <Alert tone="danger" title="Incomplete: unmapped balances">
            {r.blockers.slice(0, 10).map((b) => `${r.members.find((m) => m.orgId === b.orgId)?.name}: ${b.code} ${b.name} (${b.amount} ${b.currency})`).join("; ")}.{" "}
            <Link href={`/o/${org}/consolidation/${groupId}/mappings`} className="underline">
              Map them
            </Link>
            .
          </Alert>
        )}
      </div>
      {g.members.length === 0 ? (
        <Alert tone="info">Add members to the group first.</Alert>
      ) : (
        <div className="space-y-6">
          {sections.map((s) => {
            const part = rows.filter((x) => s.types.includes(x.groupAccount.type));
            const total = (sel: (row: (typeof part)[number]) => string) => Decimal.sum(part.map((row) => show(row.groupAccount.type, sel(row)))).toString();
            return (
              <section key={s.title}>
                <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">{s.title}</h2>
                <Table>
                  <thead>
                    <tr>
                      <Th>Group account</Th>
                      {r.members.map((m) => (
                        <Th key={m.orgId} align="right">
                          {m.name}
                        </Th>
                      ))}
                      <Th align="right">Eliminations</Th>
                      <Th align="right">Consolidated</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {part.map((row) => (
                      <tr key={row.groupAccount.id + row.groupAccount.type}>
                        <Td>
                          <span className="font-mono text-xs text-slate-500">{row.groupAccount.code}</span> {row.groupAccount.name}
                          {row.groupAccount.id === "unmapped" && <Badge tone="red">unmapped</Badge>}
                        </Td>
                        {r.members.map((m) => (
                          <Td key={m.orgId} align="right">
                            {row.groupAccount.id === "unmapped" ? (
                              <Money amount={show(row.groupAccount.type, row.perMember[m.orgId] ?? "0")} currency={rc} showZero={false} />
                            ) : (
                              <Link href={drill(m.orgId, row.groupAccount.id)} className="hover:underline">
                                <Money amount={show(row.groupAccount.type, row.perMember[m.orgId] ?? "0")} currency={rc} showZero={false} />
                              </Link>
                            )}
                          </Td>
                        ))}
                        <Td align="right">
                          <Money amount={show(row.groupAccount.type, row.eliminations)} currency={rc} showZero={false} />
                        </Td>
                        <Td align="right" className="font-medium">
                          <Money amount={show(row.groupAccount.type, row.total)} currency={rc} />
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-slate-50 font-medium">
                    <tr>
                      <Td>Total {s.title.toLowerCase()}</Td>
                      {r.members.map((m) => (
                        <Td key={m.orgId} align="right">
                          <Money amount={total((row) => row.perMember[m.orgId] ?? "0")} currency={rc} />
                        </Td>
                      ))}
                      <Td align="right">
                        <Money amount={total((row) => row.eliminations)} currency={rc} />
                      </Td>
                      <Td align="right">
                        <Money amount={total((row) => row.total)} currency={rc} />
                      </Td>
                    </tr>
                  </tfoot>
                </Table>
              </section>
            );
          })}
          <Card title="Summary">
            <dl className="grid gap-3 text-sm sm:grid-cols-3">
              {view !== "profit_and_loss" && (
                <>
                  <div>
                    <dt className="text-slate-500">Assets</dt>
                    <dd className="num font-semibold">
                      <Money amount={r.totals.assets} currency={rc} />
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Liabilities + equity + net income</dt>
                    <dd className="num font-semibold">
                      <Money amount={Decimal.from(r.totals.liabilities).add(r.totals.equity).add(r.totals.netIncome).toString()} currency={rc} />
                    </dd>
                  </div>
                </>
              )}
              <div>
                <dt className="text-slate-500">Net income for the period</dt>
                <dd className="num font-semibold">
                  <Money amount={r.totals.netIncome} currency={rc} />
                </dd>
              </div>
            </dl>
            <p className={`mt-3 text-sm ${r.balanced ? "text-emerald-700" : "text-danger-700"}`}>{r.balanced ? "The consolidated trial balance foots." : "The consolidated trial balance does not foot."}</p>
          </Card>
          <Card title="Rates and translation" padded={false}>
            <Table className="rounded-none border-0 shadow-none">
              <thead>
                <tr>
                  <Th>Member</Th>
                  <Th>Fiscal year starts</Th>
                  <Th>Closing rate</Th>
                  <Th>Average rate</Th>
                  <Th align="right">Translation adjustment</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {r.members.map((m) => (
                  <tr key={m.orgId}>
                    <Td>
                      {m.name} <span className="text-xs text-slate-500">({m.currency})</span>
                    </Td>
                    <Td>month {m.fiscalYearStartMonth}</Td>
                    <Td className="text-xs">{m.closing ? `${m.closing.rate.normalize().toString()} — ${m.closing.source}${m.closing.date ? `, ${m.closing.date}` : ""}` : "none"}</Td>
                    <Td className="text-xs">{m.average ? `${m.average.rate.normalize().toString()} — ${m.average.source}${m.average.count ? `, ${m.average.count} rates` : ""}` : "none"}</Td>
                    <Td align="right">
                      <Money amount={m.cta} currency={rc} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
          <div>
            <LinkButton variant="secondary" href={`/o/${org}/consolidation/${groupId}/eliminations?from=${from}&to=${to}`}>
              Intercompany balances
            </LinkButton>
          </div>
        </div>
      )}
    </>
  );
}
