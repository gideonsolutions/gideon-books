import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { listFiscalYears, periodHistory, previewClose } from "@/lib/ledger/periods";
import { can } from "@/lib/context";
import { todayIn } from "@/lib/dates";
import { Alert, Badge, Card, DateText, PageHeader } from "@/components/ui";
import { ActionForm, CheckboxField, ConfirmButton, SubmitButton, TextField } from "@/components/client/forms";
import { formatDateTime } from "@/lib/money/format";
import { closePeriodAction, lockDateAction, reopenPeriodAction } from "../actions";
import Link from "next/link";
import { readParams, type SearchParams } from "@/lib/web/params";

export const metadata = { title: "Periods & close" };

export default async function Periods({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  const { org } = await params;
  const sp = await readParams(searchParams);
  const ctx = await orgCtx(org);
  const db = getDb();
  const years = await listFiscalYears(db, ctx.orgId);
  const today = todayIn(ctx.org.timezone);
  const allPeriods = years.flatMap((y) => y.periods);
  const firstOpen = allPeriods.filter((p) => p.status === "open" && p.endDate < today).sort((a, b) => a.startDate.localeCompare(b.startDate))[0];
  const reviewing = sp.review ? allPeriods.find((p) => p.id === sp.review) : firstOpen;
  const review = reviewing ? await previewClose(db, ctx, reviewing.id) : null;
  const history = await periodHistory(db, ctx.orgId);
  const lastClosed = allPeriods.filter((p) => p.status === "closed").sort((a, b) => b.startDate.localeCompare(a.startDate))[0];
  const base = `/o/${org}`;
  return (
    <>
      <PageHeader
        title="Periods & close"
        description="A closed period takes no postings. Close in order, after the checklist; reopening needs the permission and a reason, and both are recorded. The lock date blocks everything on or before it regardless of period status."
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="space-y-6">
          {review && (
            <Card title={`Close checklist: ${review.period.startDate} to ${review.period.endDate}`}>
              <ul className="space-y-2">
                {review.checks.map((c) => (
                  <li key={c.key} className="flex items-start gap-3 text-sm">
                    <span aria-hidden="true" className={c.status === "pass" ? "text-emerald-600" : c.severity === "blocker" ? "text-danger-600" : "text-amber-600"}>
                      {c.status === "pass" ? "✓" : c.severity === "blocker" ? "✕" : "!"}
                    </span>
                    <span>
                      <span className="font-medium text-slate-900">{c.title}</span>
                      {c.status === "fail" && <Badge tone={c.severity === "blocker" ? "red" : "amber"}>{c.severity === "blocker" ? "must fix" : "review"}</Badge>}
                      {c.detail && <span className="block text-slate-600">{c.detail}</span>}
                      {c.href && c.status === "fail" && (
                        <Link href={`${base}${c.href}`} className="text-brand-700 hover:underline">
                          Go fix it →
                        </Link>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
              {review.period.status === "open" && can(ctx, "periods.close") && (
                <ActionForm action={closePeriodAction.bind(null, org, review.period.id)} className="mt-4 space-y-3 border-t border-slate-100 pt-4">
                  {review.checks.some((c) => c.status === "fail" && c.severity === "warning") && (
                    <CheckboxField name="acknowledge" label="I have reviewed the items above and want to close anyway." />
                  )}
                  <TextField label="Note (optional)" name="reason" />
                  <SubmitButton disabled={review.checks.some((c) => c.status === "fail" && c.severity === "blocker")}>Close the period</SubmitButton>
                </ActionForm>
              )}
            </Card>
          )}
          {years.length === 0 && <Alert tone="info">Fiscal years appear as soon as something is posted.</Alert>}
          {years.map((y) => (
            <Card key={y.id} title={`${y.name} (${y.startDate} – ${y.endDate})`} padded={false}>
              <ul className="divide-y divide-slate-100">
                {y.periods.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-sm">
                    <span className="flex items-center gap-3">
                      <span className="w-48">
                        <DateText date={p.startDate} /> – <DateText date={p.endDate} />
                      </span>
                      <Badge tone={p.status === "closed" ? "green" : "gray"}>{p.status}</Badge>
                      {ctx.org.lockDate && p.endDate <= ctx.org.lockDate && <Badge tone="amber">locked</Badge>}
                    </span>
                    <span className="flex gap-2">
                      {p.status === "open" && (
                        <Link href={`?review=${p.id}`} className="text-brand-700 hover:underline">
                          Checklist
                        </Link>
                      )}
                      {p.status === "closed" && p.id === lastClosed?.id && can(ctx, "periods.reopen") && (
                        <ConfirmButton
                          action={reopenPeriodAction.bind(null, org, p.id)}
                          label="Reopen"
                          size="sm"
                          title="Reopen this period?"
                          body="Postings into it become possible again. Reports already shared for this period may change."
                          reasonLabel="Why does it need to reopen?"
                          confirmLabel="Reopen"
                          variant="danger"
                        />
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
        <div className="space-y-6">
          <Card title="Lock date">
            <p className="mb-3 text-sm text-slate-600">
              Currently: {ctx.org.lockDate ? <strong><DateText date={ctx.org.lockDate} /></strong> : "none"}. Nothing dated on or before the lock date can be posted. Set it after filing a return or delivering financial statements.
            </p>
            {can(ctx, "periods.close") && (
              <ActionForm action={lockDateAction.bind(null, org)} className="space-y-3">
                <TextField label="Lock through" name="lockDate" type="date" defaultValue={ctx.org.lockDate ?? ""} hint="Clear it to remove the lock (moving it back needs the reopen permission)." />
                <TextField label="Reason" name="reason" required />
                <SubmitButton variant="secondary">Save lock date</SubmitButton>
              </ActionForm>
            )}
          </Card>
          <Card title="Close history">
            {history.length === 0 ? (
              <p className="text-sm text-slate-500">No periods closed yet.</p>
            ) : (
              <ol className="space-y-2 text-sm">
                {history.slice(0, 30).map((h) => (
                  <li key={h.id}>
                    <span className="font-medium">{h.action === "close" ? "Closed" : h.action === "reopen" ? "Reopened" : "Lock date"}</span> — {allPeriods.find((p) => p.id === h.periodId)?.startDate ?? ""}
                    <div className="text-xs text-slate-500">{formatDateTime(h.createdAt, ctx.org.timezone)}</div>
                    {h.reason && <div className="text-xs text-slate-700">“{h.reason}”</div>}
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
