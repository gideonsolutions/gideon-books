import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { requirePermission } from "@/lib/context";
import { searchAudit } from "@/lib/ops/audit-log";
import { dateParam, intParam, readParams, type SearchParams } from "@/lib/web/params";
import { formatDateTime } from "@/lib/money/format";
import { sourceHref } from "@/lib/web/links";
import { Badge, EmptyState, FilterBar, FilterField, PageHeader, Pagination, Table, Td, Th, buttonClass, inputClass } from "@/components/ui";

export const metadata = { title: "Audit log" };

function Diff({ before, after }: { before: unknown; after: unknown }) {
  const b = (before ?? {}) as Record<string, unknown>;
  const a = (after ?? {}) as Record<string, unknown>;
  if (typeof b !== "object" || typeof a !== "object") return null;
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => JSON.stringify(b[k]) !== JSON.stringify(a[k]) && !["updatedAt", "updated_at"].includes(k));
  if (!keys.length) return null;
  return (
    <table className="mt-1 w-full text-xs">
      <tbody>
        {keys.slice(0, 30).map((k) => (
          <tr key={k} className="align-top">
            <td className="pr-2 font-mono text-slate-500">{k}</td>
            <td className="pr-2 text-danger-700 line-through">{before ? JSON.stringify(b[k]) : ""}</td>
            <td className="text-emerald-700">{after ? JSON.stringify(a[k]) : ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default async function AuditLog({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  const { org } = await params;
  const sp = await readParams(searchParams);
  const ctx = await orgCtx(org);
  requirePermission(ctx, "audit.read");
  const filters = { action: sp.action, entityType: sp.entity, entityId: sp.id, actor: sp.actor, from: dateParam(sp.from), to: dateParam(sp.to), page: intParam(sp.page, 1) };
  const r = await searchAudit(getDb(), ctx.orgId, filters);
  const q = new URLSearchParams(Object.entries({ action: sp.action, entity: sp.entity, id: sp.id, actor: sp.actor, from: sp.from, to: sp.to }).filter(([, v]) => v) as [string, string][]).toString();
  const base = `/o/${org}`;
  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every consequential change: who, when, from where, what changed and why. The log is append-only; nobody can edit or delete it."
        actions={
          <a className={buttonClass("secondary")} href={`${base}/audit/export${q ? `?${q}` : ""}`}>
            Export CSV
          </a>
        }
      />
      <FilterBar>
        <FilterField label="Action">
          <input name="action" defaultValue={sp.action} placeholder="e.g. journal, void" className={inputClass} />
        </FilterField>
        <FilterField label="Record type">
          <select name="entity" defaultValue={sp.entity ?? ""} className={inputClass}>
            <option value="">All</option>
            {r.entityTypes.sort().map((t) => (
              <option key={t} value={t}>
                {t.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Who">
          <input name="actor" defaultValue={sp.actor} placeholder="email or token" className={inputClass} />
        </FilterField>
        <FilterField label="From">
          <input type="date" name="from" defaultValue={sp.from} className={inputClass} />
        </FilterField>
        <FilterField label="To">
          <input type="date" name="to" defaultValue={sp.to} className={inputClass} />
        </FilterField>
      </FilterBar>
      {r.rows.length === 0 ? (
        <EmptyState title="No events match">Widen the filters.</EmptyState>
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th>When (UTC)</Th>
                <Th>Who</Th>
                <Th>What</Th>
                <Th>Record</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {r.rows.map((e) => {
                const href = e.entityType === "journal_entry" ? `${base}/accounting/journal/${e.entityId}` : sourceHref(base, e.entityType, e.entityId);
                return (
                  <tr key={e.id} className="align-top">
                    <Td className="whitespace-nowrap text-xs text-slate-600">{formatDateTime(e.createdAt)}</Td>
                    <Td className="text-xs">
                      <div className="font-medium text-slate-800">{e.actorLabel}</div>
                      <div className="text-slate-500">
                        {e.actorType} via {e.source}
                        {e.ip ? ` · ${e.ip}` : ""}
                      </div>
                    </Td>
                    <Td>
                      <div className="font-medium">{e.action.replace(/[._]/g, " ")}</div>
                      {e.reason && <div className="text-xs text-slate-700">Reason: “{e.reason}”</div>}
                      {e.before || e.after || e.metadata ? (
                        <details className="mt-1 text-xs">
                          <summary className="cursor-pointer text-brand-700">Details</summary>
                          <Diff before={e.before} after={e.after} />
                          {e.metadata ? <pre className="mt-1 max-w-xl overflow-x-auto whitespace-pre-wrap rounded bg-slate-50 p-2 text-[11px] text-slate-700">{JSON.stringify(e.metadata, null, 2)}</pre> : null}
                        </details>
                      ) : null}
                    </Td>
                    <Td className="text-xs">
                      {e.entityType && <Badge>{e.entityType.replace(/_/g, " ")}</Badge>}
                      {e.entityId && (href ? (
                        <Link href={href} className="ml-1 font-mono text-brand-700 hover:underline">
                          {e.entityId.slice(0, 8)}
                        </Link>
                      ) : (
                        <Link href={`${base}/audit?entity=${e.entityType ?? ""}&id=${e.entityId}`} className="ml-1 font-mono text-slate-600 hover:underline">
                          {e.entityId.slice(0, 8)}
                        </Link>
                      ))}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          <Pagination page={r.page} pageSize={r.pageSize} total={r.total} params={sp} />
        </>
      )}
    </>
  );
}
