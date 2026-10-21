import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { requirePermission } from "@/lib/context";
import { reportDef } from "@/lib/reports/registry";
import { generalLedger } from "@/lib/reports/gl";
import { label } from "@/lib/reports/accounts";
import { resolveParams } from "@/lib/reports/scope";
import { reportPageOptions } from "@/lib/reports/page-data";
import { intParam, readParams, type SearchParams } from "@/lib/web/params";
import { sourceHref } from "@/lib/web/links";
import { Alert, Badge, DateText, EmptyState, Money, PageHeader, Pagination } from "@/components/ui";
import { ReportControls } from "@/components/reports/report-controls";

export const metadata = { title: "General ledger" };

export default async function GeneralLedgerPage({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  const { org } = await params;
  const ctx = await orgCtx(org);
  requirePermission(ctx, "reports.read");
  const sp = await readParams(searchParams);
  const db = getDb();
  const def = reportDef("general-ledger")!;
  // A drill-down with only "to" means everything up to that date.
  const resolved = resolveParams(ctx.org, sp.to && !sp.from && !sp.period ? { ...sp, from: "1900-01-01" } : sp);
  const page = intParam(sp.page, 1);
  const gl = await generalLedger(db, ctx.org, { from: resolved.from, to: resolved.to, basis: resolved.basis, filters: resolved.filters, page, pageSize: 200 });
  const { dims } = await reportPageOptions(db, ctx.orgId);
  const base = `/o/${org}`;
  const cur = ctx.org.baseCurrency;
  const filteredAccounts = resolved.filters.accountIds?.length ?? 0;
  return (
    <>
      <PageHeader title="General ledger" description={gl.table.subtitle} />
      <ReportControls def={def} resolved={resolved} params={{ ...sp, ...(resolved.from === "1900-01-01" ? { from: "1900-01-01" } : {}) }} base={base} dims={dims} exportPath="/reports/general-ledger/export" />
      {filteredAccounts > 0 && (
        <div className="mb-3 text-sm text-slate-600">
          Showing {filteredAccounts} account{filteredAccounts === 1 ? "" : "s"}.{" "}
          <Link className="text-brand-700 hover:underline" href={`?${new URLSearchParams(Object.entries({ ...sp, account: "" }).filter(([, v]) => v) as [string, string][]).toString()}`}>
            Show all accounts
          </Link>
        </div>
      )}
      {resolved.basis === "cash" && (
        <div className="mb-3">
          <Alert tone="info">Cash basis: invoices and bills appear when they are paid, as “cash-basis recognition” lines on the payment&apos;s settlement.</Alert>
        </div>
      )}
      {gl.accounts.length === 0 ? (
        <EmptyState title="No ledger lines">Nothing was posted in these dates with these filters.</EmptyState>
      ) : (
        <div className="space-y-6">
          {gl.accounts
            .filter((a) => a.lines.length > 0 || page === 1)
            .map((a) => (
              <section key={a.account.id} className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
                <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2">
                  <Link href={`${base}/accounting/accounts/${a.account.id}`} className="font-semibold text-slate-900 hover:text-brand-700">
                    {label(a.account)}
                  </Link>
                  <span className="text-xs text-slate-600">
                    {a.lineCount} line{a.lineCount === 1 ? "" : "s"} · closing <Money amount={a.closing.toString()} currency={cur} />
                  </span>
                </header>
                <table className="min-w-full text-sm">
                  <thead className="text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-3 py-1.5 text-left">Date</th>
                      <th className="px-3 py-1.5 text-left">Entry</th>
                      <th className="px-3 py-1.5 text-left">Source</th>
                      <th className="px-3 py-1.5 text-left">Contact</th>
                      <th className="px-3 py-1.5 text-left">Description</th>
                      <th className="px-3 py-1.5 text-right">Debit</th>
                      <th className="px-3 py-1.5 text-right">Credit</th>
                      <th className="px-3 py-1.5 text-right">Balance</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {resolved.from !== "1900-01-01" && page === 1 && (
                      <tr className="text-slate-600">
                        <td className="px-3 py-1.5" colSpan={7}>
                          Balance brought forward
                        </td>
                        <td className="px-3 py-1.5 text-right">
                          <Money amount={a.opening.toString()} currency={cur} />
                        </td>
                      </tr>
                    )}
                    {a.lines.map((l) => {
                      const src = sourceHref(base, l.sourceType, l.sourceId);
                      return (
                        <tr key={l.lineId}>
                          <td className="whitespace-nowrap px-3 py-1.5">
                            <DateText date={l.date} />
                          </td>
                          <td className="px-3 py-1.5">
                            <Link className="text-brand-700 hover:underline" href={`${base}/accounting/journal/${l.entryId}`}>
                              #{l.entryNumber}
                            </Link>
                          </td>
                          <td className="whitespace-nowrap px-3 py-1.5 text-slate-600">
                            {src ? (
                              <Link className="hover:underline" href={src}>
                                {l.kind.replace(/_/g, " ")} {l.sourceRef}
                              </Link>
                            ) : (
                              `${l.kind.replace(/_/g, " ")} ${l.sourceRef ?? ""}`
                            )}
                          </td>
                          <td className="px-3 py-1.5 text-slate-600">{l.contactName}</td>
                          <td className="max-w-sm px-3 py-1.5">
                            {l.description} {l.recognized && <Badge tone="blue">cash-basis recognition</Badge>}
                            {l.currency !== cur && (
                              <span className="ml-1 text-xs text-slate-500">
                                (<Money amount={l.txnAmount} currency={l.currency} />)
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-1.5 text-right">{l.amount.isPositive() && <Money amount={l.amount.toString()} currency={cur} />}</td>
                          <td className="px-3 py-1.5 text-right">{l.amount.isNegative() && <Money amount={l.amount.neg().toString()} currency={cur} />}</td>
                          <td className="px-3 py-1.5 text-right">
                            <Money amount={l.running.toString()} currency={cur} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot className="bg-slate-50 font-medium">
                    <tr>
                      <td className="px-3 py-1.5" colSpan={5}>
                        Total for the period
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        <Money amount={a.debits.toString()} currency={cur} />
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        <Money amount={a.credits.toString()} currency={cur} />
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        <Money amount={a.closing.toString()} currency={cur} />
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </section>
            ))}
          <Pagination page={page} pageSize={gl.pageSize} total={gl.totalLines} params={sp} />
        </div>
      )}
    </>
  );
}
