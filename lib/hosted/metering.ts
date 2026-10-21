/**
 * Usage metering for the hosted offering. When HOSTED_MODE is not "true"
 * (self-hosting), nothing is recorded and nothing is limited: the core never
 * depends on a plan. When hosted, cost-bearing services record what they use
 * and check the organization's plan limit before doing more.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import { usageEvents, type UsageMetric } from "@/lib/db/schema/hosted";
import { AppError } from "@/lib/errors";
import { limitFor } from "./plans";

export function hostedMode(): boolean {
  return process.env.HOSTED_MODE === "true";
}

export class UsageLimitError extends AppError {
  constructor(metric: UsageMetric, limit: number) {
    super(
      402,
      "usage_limit_reached",
      `This organization has used its plan's ${metric.replace(/_/g, " ")} for the month (${limit.toLocaleString("en-US")}). Existing records stay available; see Settings → Plan & usage.`,
      { details: { metric, limit } },
    );
  }
}

function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function usageThisMonth(db: DbOrTx, orgId: string, metric: UsageMetric): Promise<number> {
  const [r] = await db
    .select({ n: sql<string>`coalesce(sum(${usageEvents.quantity}), 0)::text` })
    .from(usageEvents)
    .where(and(eq(usageEvents.orgId, orgId), eq(usageEvents.metric, metric), metric === "storage_bytes" ? sql`true` : gte(usageEvents.occurredAt, monthStart())));
  return Number(r?.n ?? 0);
}

/** Refuse if `quantity` more would exceed the plan's limit (hosted only). */
export async function assertWithinLimit(db: DbOrTx, orgId: string, metric: UsageMetric, quantity = 1): Promise<void> {
  if (!hostedMode()) return;
  const limit = await limitFor(db, orgId, metric);
  if (limit === null) return;
  const used = await usageThisMonth(db, orgId, metric);
  if (used + quantity > limit) throw new UsageLimitError(metric, limit);
}

export async function recordUsage(db: DbOrTx, orgId: string, metric: UsageMetric, quantity: number, ref?: string | null): Promise<void> {
  if (!hostedMode()) return;
  await db.insert(usageEvents).values({ orgId, metric, quantity, ref: ref ?? null });
}
