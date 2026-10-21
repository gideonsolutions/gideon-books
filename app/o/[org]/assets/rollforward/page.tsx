import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { requirePermission } from "@/lib/context";
import { assetRollforward } from "@/lib/assets/reports";
import { fiscalYearStart } from "@/lib/ledger/periods";
import { todayIn } from "@/lib/dates";
import { Alert, LinkButton, Money, PageHeader, Table, Td, Th, buttonClass, inputClass } from "@/components/ui";
import { AssetTabs } from "@/components/assets/tabs";

export const metadata = { title: "Fixed-asset rollforward" };

export default async function Rollforward({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ from?: string; to?: string }> }) {
  const { org } = await params;
  const sp = await searchParams;
  const ctx = await orgCtx(org);
  requirePermission(ctx, "reports.read");
  const today = todayIn(ctx.org.timezone);
  const valid = (d?: string) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : undefined);
  const from = valid(sp.from) ?? fiscalYearStart(today, ctx.org.fiscalYearStartMonth);
  const to = valid(sp.to) ?? today;
  const r = await assetRollforward(getDb(), ctx.orgId, from, to);
  const cur = ctx.org.baseCurrency;
  const base = `/o/${org}`;
  const gl = (accountId: string) => `${base}/reports/general-ledger?account=${accountId}&to=${to}`;
  return (
    <>
      <PageHeader
        title="Fixed-asset rollforward"
        description={`Cost and accumulated depreciation from ${from} to ${to}, by ledger date, reconciled to the asset and accumulated depreciation accounts.`}
        actions={
          <LinkButton variant="secondary" href={`${base}/assets/rollforward/export?from=${from}&to=${to}`}>
            Export CSV
          </LinkButton>
        }
      />
      <AssetTabs org={org} current="rollforward" />
      <form method="get" className="mb-4 flex flex-wrap items-end gap-3 no-print">
        <label className="text-xs font-medium text-slate-600">
          From
          <input type="date" name="from" defaultValue={from} className={`${inputClass} mt-1`} />
        </label>
        <label className="text-xs font-medium text-slate-600">
          To
          <input type="date" name="to" defaultValue={to} className={`${inputClass} mt-1`} />
        </label>
        <button className={buttonClass("secondary")}>Apply</button>
      </form>
      <div className="mb-4">
        {r.reconciled ? (
          <Alert tone="success">The register agrees with the ledger at {to}.</Alert>
        ) : (
          <Alert tone="danger" title="The register and the ledger differ">
            See the reconciliation below. Common causes: a bill to a fixed-asset account not yet capitalized, a void bill whose asset is still in the register, or a journal entry to an asset account outside the register.
          </Alert>
        )}
      </div>
      <Table>
        <thead>
          <tr>
            <Th>Asset</Th>
            <Th align="right">Opening cost</Th>
            <Th align="right">Additions</Th>
            <Th align="right">Disposals</Th>
            <Th align="right">Closing cost</Th>
            <Th align="right">Opening acc. dep.</Th>
            <Th align="right">Depreciation</Th>
            <Th align="right">Disposals</Th>
            <Th align="right">Closing acc. dep.</Th>
            <Th align="right">Net book value</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {r.rows.map((x) => (
            <tr key={x.assetId}>
              <Td>
                <Link href={`${base}/assets/${x.assetId}`} className="text-brand-700 hover:underline">
                  {x.number}
                </Link>{" "}
                {x.name}
              </Td>
              <Td align="right"><Money amount={x.openingCost.toString()} currency={cur} /></Td>
              <Td align="right"><Money amount={x.additions.toString()} currency={cur} showZero={false} /></Td>
              <Td align="right"><Money amount={x.disposals.toString()} currency={cur} showZero={false} /></Td>
              <Td align="right"><Money amount={x.closingCost.toString()} currency={cur} /></Td>
              <Td align="right"><Money amount={x.openingAccumulated.add(x.acquiredAccumulated).toString()} currency={cur} /></Td>
              <Td align="right"><Money amount={x.depreciation.toString()} currency={cur} showZero={false} /></Td>
              <Td align="right"><Money amount={x.disposalsAccumulated.toString()} currency={cur} showZero={false} /></Td>
              <Td align="right"><Money amount={x.closingAccumulated.toString()} currency={cur} /></Td>
              <Td align="right"><Money amount={x.closingNbv.toString()} currency={cur} /></Td>
            </tr>
          ))}
        </tbody>
        <tfoot className="bg-slate-50 font-medium">
          <tr>
            <Td>Total</Td>
            <Td align="right"><Money amount={r.totals.openingCost.toString()} currency={cur} /></Td>
            <Td align="right"><Money amount={r.totals.additions.toString()} currency={cur} /></Td>
            <Td align="right"><Money amount={r.totals.disposals.toString()} currency={cur} /></Td>
            <Td align="right"><Money amount={r.totals.closingCost.toString()} currency={cur} /></Td>
            <Td align="right"><Money amount={r.totals.openingAccumulated.add(r.totals.acquiredAccumulated).toString()} currency={cur} /></Td>
            <Td align="right"><Money amount={r.totals.depreciation.toString()} currency={cur} /></Td>
            <Td align="right"><Money amount={r.totals.disposalsAccumulated.toString()} currency={cur} /></Td>
            <Td align="right"><Money amount={r.totals.closingAccumulated.toString()} currency={cur} /></Td>
            <Td align="right"><Money amount={r.totals.closingNbv.toString()} currency={cur} /></Td>
          </tr>
        </tfoot>
      </Table>
      <p className="mt-2 text-xs text-slate-500">Opening accumulated depreciation includes depreciation brought in with opening-balance assets added in the period.</p>
      <h2 className="mb-2 mt-8 text-sm font-semibold uppercase tracking-wide text-slate-500">Reconciliation to the ledger at {to}</h2>
      <Table>
        <thead>
          <tr>
            <Th>Account</Th>
            <Th align="right">Register</Th>
            <Th align="right">Ledger</Th>
            <Th align="right">Difference</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {r.ties.map((t) => (
            <tr key={t.accountId}>
              <Td>
                {t.code} {t.name} <span className="text-xs text-slate-500">({t.kind === "cost" ? "cost" : "accumulated depreciation"})</span>
              </Td>
              <Td align="right"><Money amount={t.register.toString()} currency={cur} /></Td>
              <Td align="right">
                <Link href={gl(t.accountId)} className="hover:underline">
                  <Money amount={t.ledger.toString()} currency={cur} />
                </Link>
              </Td>
              <Td align="right" className={t.difference.isZero() ? "" : "font-semibold text-danger-700"}>
                <Money amount={t.difference.toString()} currency={cur} />
              </Td>
            </tr>
          ))}
          {r.ties.length === 0 && (
            <tr>
              <Td colSpan={4} className="text-slate-500">No fixed-asset balances.</Td>
            </tr>
          )}
        </tbody>
      </Table>
    </>
  );
}
