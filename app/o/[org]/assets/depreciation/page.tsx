import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { can } from "@/lib/context";
import { dueDepreciation, getAssetSettings, listRuns } from "@/lib/assets/depreciation";
import { addMonths, endOfMonth, startOfMonth, todayIn } from "@/lib/dates";
import { Decimal } from "@/lib/money/decimal";
import { Alert, Badge, Card, DateText, EmptyState, Money, PageHeader, Table, Td, Th } from "@/components/ui";
import { ActionForm, CheckboxField, SubmitButton, TextField } from "@/components/client/forms";
import { AssetTabs } from "@/components/assets/tabs";
import { autoPostAction, prepareRunAction } from "../actions";

export const metadata = { title: "Depreciation runs" };

export default async function DepreciationRuns({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ through?: string }> }) {
  const { org } = await params;
  const sp = await searchParams;
  const ctx = await orgCtx(org);
  const db = getDb();
  const runs = await listRuns(db, ctx.orgId);
  const lastMonthEnd = endOfMonth(addMonths(startOfMonth(todayIn(ctx.org.timezone)), -1));
  const through = sp.through && /^\d{4}-\d{2}-\d{2}$/.test(sp.through) ? endOfMonth(sp.through) : lastMonthEnd;
  const due = await dueDepreciation(db, ctx, through);
  const dueTotal = Decimal.sum(due.map((d) => d.amount));
  const settings = await getAssetSettings(db, ctx.orgId);
  const base = `/o/${org}`;
  const cur = ctx.org.baseCurrency;
  const may = can(ctx, "assets.depreciate");
  return (
    <>
      <PageHeader
        title="Depreciation runs"
        description="Each run takes the depreciation due through a month-end, for review, then posts it as one entry. An asset-month is depreciated once: a posted month is never posted again, and reversing a run frees its months."
      />
      <AssetTabs org={org} current="depreciation" />
      <div className="mb-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Card title={`Due through ${through}`}>
          {due.length === 0 ? (
            <p className="text-sm text-slate-600">Nothing is due: every asset-month through this date is posted or in a draft run.</p>
          ) : (
            <>
              <p className="mb-3 text-sm text-slate-700">
                {due.length} asset-month{due.length === 1 ? "" : "s"} totalling <Money amount={dueTotal.toString()} currency={cur} /> (months missed earlier are included).
              </p>
              <ul className="mb-3 max-h-48 overflow-y-auto text-sm">
                {due.slice(0, 50).map((d) => (
                  <li key={`${d.assetId}${d.periodEnd}`} className="flex justify-between gap-2 py-0.5">
                    <span>
                      {d.assetNumber} {d.assetName} · <DateText date={d.periodEnd} />
                    </span>
                    <Money amount={d.amount.toString()} currency={cur} />
                  </li>
                ))}
              </ul>
            </>
          )}
          {may && (
            <ActionForm action={prepareRunAction.bind(null, org)} className="flex flex-wrap items-end gap-3">
              <TextField label="Through month-end" name="periodEnd" type="date" required defaultValue={through} />
              <SubmitButton pendingText="Preparing…">Prepare run for review</SubmitButton>
            </ActionForm>
          )}
          <form method="get" className="mt-3 text-xs text-slate-500">
            Preview another month-end:{" "}
            <input type="date" name="through" defaultValue={through} className="rounded border border-slate-300 px-1 py-0.5" />{" "}
            <button className="text-brand-700 hover:underline">Show</button>
          </form>
        </Card>
        <Card title="Monthly run">
          <p className="mb-3 text-sm text-slate-600">
            Each month the background worker prepares the run for the month just ended. It waits for review unless you turn on automatic posting.
          </p>
          {may ? (
            <ActionForm action={autoPostAction.bind(null, org)} className="space-y-3">
              <CheckboxField label="Post the monthly run automatically" name="autoPost" defaultChecked={settings.autoPostDepreciation} hint="Off by default. Runs into a closed period always wait." />
              <SubmitButton variant="secondary">Save</SubmitButton>
            </ActionForm>
          ) : (
            <p className="text-sm">Automatic posting is {settings.autoPostDepreciation ? "on" : "off"}.</p>
          )}
        </Card>
      </div>
      {runs.length === 0 ? (
        <EmptyState title="No runs yet">Prepare the first run when assets are on the books.</EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Through</Th>
              <Th>Status</Th>
              <Th align="right">Total</Th>
              <Th className="hidden md:table-cell">Prepared by</Th>
              <Th className="hidden md:table-cell">Entry</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {runs.map((r) => (
              <tr key={r.id} className="hover:bg-slate-50">
                <Td>
                  <Link href={`${base}/assets/depreciation/${r.id}`} className="font-medium text-brand-700 hover:underline">
                    <DateText date={r.periodEnd} />
                  </Link>
                </Td>
                <Td>
                  <Badge tone={r.status === "posted" ? "green" : r.status === "draft" ? "amber" : "red"}>{r.status === "draft" ? "awaiting review" : r.status}</Badge>
                </Td>
                <Td align="right">
                  <Money amount={r.total} currency={cur} />
                </Td>
                <Td className="hidden text-slate-600 md:table-cell">{r.preparedByLabel}</Td>
                <Td className="hidden md:table-cell">
                  {r.journalEntryId ? (
                    <Link className="text-brand-700 hover:underline" href={`${base}/accounting/journal/${r.journalEntryId}`}>
                      View
                    </Link>
                  ) : (
                    "—"
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {!may && (
        <div className="mt-4">
          <Alert tone="info">Your role can see depreciation runs but not prepare or post them.</Alert>
        </div>
      )}
    </>
  );
}
