import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { can } from "@/lib/context";
import { getReconciliation, reconciliationLinesFor, reconciliationReport } from "@/lib/banking/reconcile";
import { loadMoneyAccount } from "@/lib/banking/common";
import { listAudit } from "@/lib/audit";
import { formatDateTime } from "@/lib/money/format";
import { Decimal } from "@/lib/money/decimal";
import { Alert, Badge, Card, DateText, DescriptionList, Money, PageHeader, Table, Td, Th } from "@/components/ui";
import { ConfirmButton } from "@/components/client/forms";
import { AuditTrail } from "@/components/audit-trail";
import { ReconcileScreen } from "@/components/banking/reconcile-screen";
import { cancelReconciliationAction, completeReconciliationAction, saveClearedAction, undoReconciliationAction } from "../../actions";

export const metadata = { title: "Reconciliation" };

export default async function ReconciliationPage({ params }: { params: Promise<{ org: string; id: string }> }) {
  const { org, id } = await params;
  const ctx = await orgCtx(org);
  const db = getDb();
  const rec = await getReconciliation(db, ctx.orgId, id);
  const account = await loadMoneyAccount(db, ctx, rec.accountId);
  const cur = account.currencyResolved;
  const base = `/o/${org}`;
  const title = (
    <span className="flex flex-wrap items-center gap-2">
      {account.name} to <DateText date={rec.statementDate} />
      <Badge tone={rec.status === "completed" ? "green" : rec.status === "in_progress" ? "amber" : "red"}>{rec.status.replace("_", " ")}</Badge>
    </span>
  );

  if (rec.status === "in_progress") {
    const lines = await reconciliationLinesFor(db, ctx, rec);
    return (
      <>
        <PageHeader
          title={title}
          back={{ href: `${base}/banking/reconciliations`, label: "Reconciliations" }}
          description="Tick every item that appears on the statement. Bank-matched items are ticked already."
          actions={
            can(ctx, "banking.reconcile") && (
              <ConfirmButton
                action={cancelReconciliationAction.bind(null, org, id)}
                label="Cancel"
                title="Cancel this reconciliation?"
                body="Nothing has been posted; the ticks are discarded."
                confirmLabel="Cancel reconciliation"
                variant="danger"
                successRedirect={`${base}/banking/reconciliations`}
              />
            )
          }
        />
        <ReconcileScreen
          lines={lines}
          opening={rec.openingBalance}
          statement={rec.statementBalance}
          currency={cur}
          base={base}
          save={saveClearedAction.bind(null, org, id)}
          complete={completeReconciliationAction.bind(null, org, id)}
          canAdjust={can(ctx, "banking.reconcile")}
        />
      </>
    );
  }

  const report = await reconciliationReport(db, ctx, rec);
  const lines = report.cleared.map((c) => ({ amount: c.amount }));
  const deposits = Decimal.sum(lines.filter((l) => Decimal.from(l.amount).isPositive()).map((l) => l.amount));
  const payments = Decimal.sum(lines.filter((l) => Decimal.from(l.amount).isNegative()).map((l) => l.amount));
  const history = await listAudit(db, ctx.orgId, { entityType: "reconciliation", entityId: id });
  return (
    <>
      <PageHeader
        title={title}
        back={{ href: `${base}/banking/reconciliations`, label: "Reconciliations" }}
        actions={
          rec.status === "completed" &&
          can(ctx, "banking.reconcile.reopen") && (
            <ConfirmButton
              action={undoReconciliationAction.bind(null, org, id)}
              label="Undo reconciliation"
              title="Undo this reconciliation?"
              body="Its items become uncleared again. Only the latest reconciliation of the account can be undone; an adjustment it posted is reversed."
              reasonLabel="Why?"
              confirmLabel="Undo"
              variant="danger"
            />
          )
        }
      />
      {rec.status === "undone" && (
        <div className="mb-4">
          <Alert tone="warning" title="Undone">
            {rec.undoReason}
          </Alert>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-6">
          <Card title="Summary">
            <DescriptionList
              items={[
                { label: "Opening balance", value: <Money amount={rec.openingBalance} currency={cur} /> },
                { label: "Cleared deposits", value: <Money amount={deposits.toString()} currency={cur} /> },
                { label: "Cleared payments", value: <Money amount={payments.neg().toString()} currency={cur} /> },
                { label: "Statement ending balance", value: <Money amount={rec.statementBalance} currency={cur} /> },
                {
                  label: "Adjustment",
                  value: rec.adjustmentEntryId ? (
                    <Link href={`${base}/accounting/journal/${rec.adjustmentEntryId}`} className="text-brand-700 hover:underline">
                      <Money amount={rec.difference ?? "0"} currency={cur} /> — {rec.adjustmentReason}
                    </Link>
                  ) : (
                    "None"
                  ),
                },
                { label: "Completed", value: rec.completedAt ? formatDateTime(rec.completedAt, ctx.org.timezone) : "—" },
              ]}
            />
          </Card>
          <Card title={`Outstanding at ${rec.statementDate} (${report.outstanding.length})`} padded={false}>
            {report.outstanding.length === 0 ? (
              <p className="p-4 text-sm text-slate-500">Nothing was outstanding.</p>
            ) : (
              <Table className="rounded-none border-0 shadow-none">
                <thead>
                  <tr>
                    <Th>Date</Th>
                    <Th>Description</Th>
                    <Th align="right">Amount</Th>
                    <Th>Cleared later</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {report.outstanding.map((o) => (
                    <tr key={o.line_id}>
                      <Td>
                        <DateText date={o.entry_date} />
                      </Td>
                      <Td>
                        <Link href={`${base}/accounting/journal/${o.entry_id}`} className="hover:text-brand-700">
                          {o.description}
                        </Link>
                      </Td>
                      <Td align="right">
                        <Money amount={o.amount} currency={cur} />
                      </Td>
                      <Td>{o.cleared_later ? <DateText date={o.cleared_later} /> : <span className="text-slate-400">not yet</span>}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <Card title={`Cleared (${report.cleared.length})`} padded={false}>
            <Table className="rounded-none border-0 shadow-none">
              <thead>
                <tr>
                  <Th>Date</Th>
                  <Th>Description</Th>
                  <Th align="right">Amount</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {report.cleared.map((c) => (
                  <tr key={c.line_id}>
                    <Td>
                      <DateText date={c.entry_date} />
                    </Td>
                    <Td>
                      <Link href={`${base}/accounting/journal/${c.entry_id}`} className="hover:text-brand-700">
                        {c.description}
                      </Link>
                      {c.reversed && <Badge tone="red">reversed since — check it</Badge>}
                    </Td>
                    <Td align="right">
                      <Money amount={c.amount} currency={cur} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </div>
        <div className="space-y-4">
          <AuditTrail events={history} />
        </div>
      </div>
    </>
  );
}
