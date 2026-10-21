import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { can, requirePermission } from "@/lib/context";
import { listJobs } from "@/lib/jobs/queue";
import { JOB_LABELS } from "@/lib/jobs/handlers";
import { OPS_JOB_LABELS } from "@/lib/ops/jobs";
import { readParams, type SearchParams } from "@/lib/web/params";
import { formatDateTime } from "@/lib/money/format";
import { Badge, EmptyState, FilterBar, FilterField, PageHeader, Table, Td, Th, inputClass, statusTone } from "@/components/ui";
import { ActionButton } from "@/components/client/forms";
import { cancelJobAction, retryJobAction } from "./actions";

export const metadata = { title: "Background jobs" };

const STATUSES = ["queued", "running", "succeeded", "failed", "dead", "cancelled"];

function label(kind: string) {
  return JOB_LABELS[kind] ?? OPS_JOB_LABELS[kind] ?? kind.replace(/[._]/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export default async function Jobs({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  const { org } = await params;
  const sp = await readParams(searchParams);
  const ctx = await orgCtx(org);
  requirePermission(ctx, "jobs.read");
  const jobs = await listJobs(getDb(), ctx.orgId, { status: STATUSES.includes(sp.status ?? "") ? sp.status : undefined, limit: 200 });
  const manage = can(ctx, "org.settings");
  return (
    <>
      <PageHeader
        title="Background jobs"
        description="Work done outside a page load: sending email, recurring documents, bank syncs, exports, depreciation, reversals. Failures retry with growing delays; a job that keeps failing stops (dead) and waits here for a person."
      />
      <FilterBar>
        <FilterField label="Status">
          <select name="status" defaultValue={sp.status ?? ""} className={inputClass}>
            <option value="">All</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </FilterField>
      </FilterBar>
      {jobs.length === 0 ? (
        <EmptyState title="No jobs">Nothing has run in the background for this organization{sp.status ? " with that status" : ""}.</EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Job</Th>
              <Th>Status</Th>
              <Th>Attempts</Th>
              <Th>Created</Th>
              <Th>Next run / finished</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {jobs.map((j) => (
              <tr key={j.id} className="align-top">
                <Td>
                  <div className="font-medium">{label(j.kind)}</div>
                  <div className="font-mono text-xs text-slate-400">{j.kind}</div>
                  {j.lastError && <div className="mt-1 max-w-md text-xs text-danger-700">{j.lastError}</div>}
                  {j.progress ? <div className="mt-1 text-xs text-slate-500">{JSON.stringify(j.progress)}</div> : null}
                </Td>
                <Td>
                  <Badge tone={statusTone(j.status)}>{j.status}</Badge>
                </Td>
                <Td className="num">
                  {j.attempts} / {j.maxAttempts}
                </Td>
                <Td className="text-xs text-slate-600">{formatDateTime(j.createdAt)}</Td>
                <Td className="text-xs text-slate-600">{j.finishedAt ? formatDateTime(j.finishedAt) : formatDateTime(j.runAt)}</Td>
                <Td align="right">
                  {manage && ["failed", "dead", "cancelled"].includes(j.status) && (
                    <ActionButton action={retryJobAction.bind(null, org, j.id)} size="sm">
                      Retry
                    </ActionButton>
                  )}
                  {manage && ["queued", "failed"].includes(j.status) && (
                    <ActionButton action={cancelJobAction.bind(null, org, j.id)} size="sm" variant="ghost">
                      Cancel
                    </ActionButton>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
