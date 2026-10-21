import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { can } from "@/lib/context";
import { getRun } from "@/lib/assets/depreciation";
import { listAudit } from "@/lib/audit";
import { todayIn } from "@/lib/dates";
import { Alert, Badge, Card, DateText, Money, PageHeader, Table, Td, Th } from "@/components/ui";
import { ActionButton, ConfirmButton } from "@/components/client/forms";
import { AssetTabs } from "@/components/assets/tabs";
import { AuditTrail } from "@/components/audit-trail";
import { discardRunAction, postRunAction, reverseRunAction } from "../../actions";

export const metadata = { title: "Depreciation run" };

export default async function RunPage({ params }: { params: Promise<{ org: string; id: string }> }) {
  const { org, id } = await params;
  const ctx = await orgCtx(org);
  const db = getDb();
  const { run, lines } = await getRun(db, ctx.orgId, id);
  const history = await listAudit(db, ctx.orgId, { entityType: "depreciation_run", entityId: id });
  const base = `/o/${org}`;
  const cur = ctx.org.baseCurrency;
  const may = can(ctx, "assets.depreciate");
  const today = todayIn(ctx.org.timezone);
  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            Depreciation through <DateText date={run.periodEnd} />
            <Badge tone={run.status === "posted" ? "green" : run.status === "draft" ? "amber" : "red"}>{run.status === "draft" ? "awaiting review" : run.status}</Badge>
          </span>
        }
        back={{ href: `${base}/assets/depreciation`, label: "Depreciation runs" }}
        actions={
          may && (
            <>
              {run.status === "draft" && (
                <>
                  <ActionButton action={postRunAction.bind(null, org, id)} variant="primary">
                    Approve and post
                  </ActionButton>
                  <ConfirmButton action={discardRunAction.bind(null, org, id)} label="Discard" title="Discard this draft run?" body="Its months become due again." confirmLabel="Discard" variant="danger" />
                </>
              )}
              {run.status === "posted" && (
                <ConfirmButton
                  action={reverseRunAction.bind(null, org, id)}
                  label="Reverse run"
                  title="Reverse this depreciation run?"
                  body="Its entry is reversed and its asset-months can be depreciated again. Later runs for the same assets must be reversed first."
                  dateLabel="Reversal date"
                  defaultDate={today < run.periodEnd ? run.periodEnd : today}
                  reasonLabel="Why?"
                  confirmLabel="Reverse"
                  variant="danger"
                />
              )}
            </>
          )
        }
      />
      <AssetTabs org={org} current="depreciation" />
      {run.status === "draft" && (
        <div className="mb-4">
          <Alert tone="warning">Review the amounts. Nothing is posted until the run is approved; it posts as one entry dated {run.periodEnd}.</Alert>
        </div>
      )}
      {run.status === "reversed" && (
        <div className="mb-4">
          <Alert tone="info">Reversed: {run.reversalReason}</Alert>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Table>
          <thead>
            <tr>
              <Th>Asset</Th>
              <Th>Month</Th>
              <Th align="right">Depreciation</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {lines.map(({ line, asset }) => (
              <tr key={line.id}>
                <Td>
                  <Link href={`${base}/assets/${asset.id}`} className="text-brand-700 hover:underline">
                    {asset.number}
                  </Link>{" "}
                  {asset.name}
                </Td>
                <Td>
                  <DateText date={line.periodEnd} />
                </Td>
                <Td align="right">
                  <Money amount={line.amount} currency={cur} />
                </Td>
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-slate-50 font-medium">
            <tr>
              <Td colSpan={2}>Total</Td>
              <Td align="right">
                <Money amount={run.total} currency={cur} />
              </Td>
            </tr>
          </tfoot>
        </Table>
        <div className="space-y-6">
          <Card title="Run">
            <dl className="space-y-1 text-sm">
              <div>Prepared by {run.preparedByLabel}</div>
              {run.journalEntryId && (
                <div>
                  <Link className="text-brand-700 hover:underline" href={`${base}/accounting/journal/${run.journalEntryId}`}>
                    Posted entry
                  </Link>
                </div>
              )}
              {run.reversalEntryId && (
                <div>
                  <Link className="text-brand-700 hover:underline" href={`${base}/accounting/journal/${run.reversalEntryId}`}>
                    Reversal entry
                  </Link>
                </div>
              )}
            </dl>
          </Card>
          <AuditTrail events={history} />
        </div>
      </div>
    </>
  );
}
