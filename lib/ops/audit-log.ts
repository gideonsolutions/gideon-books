/** Searching and exporting the audit trail of an organization. */
import { and, desc, eq, gte, ilike, lt, sql, type SQL } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import { auditEvents } from "@/lib/db/schema/core";

export interface AuditFilters {
  action?: string;
  entityType?: string;
  entityId?: string;
  actor?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

function conditions(orgId: string, f: AuditFilters): SQL[] {
  const conds: SQL[] = [eq(auditEvents.orgId, orgId)];
  const like = (v: string) => `%${v.replace(/[%_]/g, "\\$&")}%`;
  if (f.action) conds.push(ilike(auditEvents.action, like(f.action)));
  if (f.entityType) conds.push(eq(auditEvents.entityType, f.entityType));
  if (f.entityId) conds.push(eq(auditEvents.entityId, f.entityId));
  if (f.actor) conds.push(ilike(auditEvents.actorLabel, like(f.actor)));
  if (f.from) conds.push(gte(auditEvents.createdAt, new Date(`${f.from}T00:00:00Z`)));
  if (f.to) conds.push(lt(auditEvents.createdAt, new Date(new Date(`${f.to}T00:00:00Z`).getTime() + 86_400_000)));
  return conds;
}

export async function searchAudit(db: DbOrTx, orgId: string, f: AuditFilters) {
  const pageSize = Math.min(Math.max(f.pageSize ?? 50, 1), 500);
  const page = Math.max(f.page ?? 1, 1);
  const where = and(...conditions(orgId, f));
  const [rows, [count]] = await Promise.all([
    db.select().from(auditEvents).where(where).orderBy(desc(auditEvents.id)).limit(pageSize).offset((page - 1) * pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(auditEvents).where(where),
  ]);
  const types = await db.selectDistinct({ t: auditEvents.entityType }).from(auditEvents).where(eq(auditEvents.orgId, orgId));
  return { rows, total: count?.n ?? 0, page, pageSize, entityTypes: types.map((t) => t.t).filter(Boolean) as string[] };
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : typeof v === "string" ? v : v instanceof Date ? v.toISOString() : JSON.stringify(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The whole filtered trail as CSV (up to 100,000 events). */
export async function auditCsv(db: DbOrTx, orgId: string, f: AuditFilters): Promise<string> {
  const rows = await db.select().from(auditEvents).where(and(...conditions(orgId, f))).orderBy(desc(auditEvents.id)).limit(100_000);
  const head = ["id", "time_utc", "actor", "actor_type", "source", "action", "entity_type", "entity_id", "reason", "before", "after", "metadata", "ip", "request_id"];
  const lines = [head.join(",")];
  for (const r of rows) {
    lines.push([r.id, r.createdAt, r.actorLabel, r.actorType, r.source, r.action, r.entityType, r.entityId, r.reason, r.before, r.after, r.metadata, r.ip, r.requestId].map(csvCell).join(","));
  }
  return lines.join("\n") + "\n";
}
