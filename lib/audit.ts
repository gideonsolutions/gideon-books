/**
 * The audit trail. Every consequential change writes one event in the same
 * transaction as the change, so the trail and the books cannot disagree.
 * Values that look like secrets are redacted before they are stored.
 */
import { and, desc, eq, lt, type SQL } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import { auditEvents } from "@/lib/db/schema/core";
import type { Ctx } from "@/lib/context";
import { redact } from "@/lib/audit-redact";

export { redact };

export interface AuditInput {
  action: string;
  entityType?: string;
  entityId?: string | null;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
}

export async function audit(db: DbOrTx, ctx: Ctx, input: AuditInput): Promise<void> {
  await db.insert(auditEvents).values({
    orgId: ctx.orgId,
    actorUserId: ctx.actor.userId,
    actorType: ctx.actor.type,
    actorLabel: ctx.actor.label,
    action: input.action,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    source: ctx.source,
    reason: input.reason ?? null,
    before: input.before === undefined ? null : redact(input.before),
    after: input.after === undefined ? null : redact(input.after),
    metadata: input.metadata ? (redact(input.metadata) as Record<string, unknown>) : null,
    ip: ctx.ip ?? null,
    requestId: ctx.requestId,
  });
}

/** Instance-level events (sign-in, sign-up) that belong to no organization. */
export async function auditInstance(
  db: DbOrTx,
  input: AuditInput & { actorUserId?: string | null; actorLabel: string; ip?: string | null; source?: "ui" | "api" | "cli" | "system" },
): Promise<void> {
  await db.insert(auditEvents).values({
    orgId: null,
    actorUserId: input.actorUserId ?? null,
    actorType: input.actorUserId ? "user" : "system",
    actorLabel: input.actorLabel,
    action: input.action,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    source: input.source ?? "ui",
    reason: input.reason ?? null,
    before: input.before === undefined ? null : redact(input.before),
    after: input.after === undefined ? null : redact(input.after),
    metadata: input.metadata ? (redact(input.metadata) as Record<string, unknown>) : null,
    ip: input.ip ?? null,
  });
}

export async function listAudit(
  db: DbOrTx,
  orgId: string,
  opts: { entityType?: string; entityId?: string; before?: number; limit?: number; action?: string } = {},
) {
  const conds: SQL[] = [eq(auditEvents.orgId, orgId)];
  if (opts.entityType) conds.push(eq(auditEvents.entityType, opts.entityType));
  if (opts.entityId) conds.push(eq(auditEvents.entityId, opts.entityId));
  if (opts.action) conds.push(eq(auditEvents.action, opts.action));
  if (opts.before) conds.push(lt(auditEvents.id, opts.before));
  return db
    .select()
    .from(auditEvents)
    .where(and(...conds))
    .orderBy(desc(auditEvents.id))
    .limit(Math.min(opts.limit ?? 50, 500));
}
