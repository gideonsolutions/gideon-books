/**
 * Plans for the hosted offering. The price is configuration, not a promise:
 * HOSTED_PLANS (JSON) overrides the defaults below, and the billing page
 * labels the price as tentative. A null limit is unlimited.
 *
 * What a subscription state means for limits (cost-bearing services only —
 * reading the books, reports and the full data export are never limited):
 *   no subscription yet, trialing, incomplete → the plan's limits (trial)
 *   active, past_due (grace period)          → the plan's limits
 *   canceled                                 → zero: feeds, email delivery and uploads stop
 */
import { eq } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import type { UsageMetric } from "@/lib/db/schema/hosted";
import { subscriptions } from "@/lib/db/schema/hosted";

export interface Plan {
  key: string;
  name: string;
  /** Tentative monthly price in USD cents; shown as "tentative" until billing is live. */
  monthlyPriceCents: number;
  limits: Record<UsageMetric, number | null>;
}

export const DEFAULT_PLANS: Plan[] = [
  {
    key: "pro",
    name: "Gideon Books Pro (hosted)",
    monthlyPriceCents: 1000,
    limits: { bank_feed_syncs: 300, documents_processed: 500, storage_bytes: 5 * 1024 ** 3, emails_sent: 1000 },
  },
];

export function plans(): Plan[] {
  const raw = process.env.HOSTED_PLANS;
  if (!raw) return DEFAULT_PLANS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("HOSTED_PLANS is not valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("HOSTED_PLANS must be a non-empty array of plans");
  return parsed as Plan[];
}

export function planByKey(key: string | null | undefined): Plan {
  const all = plans();
  return all.find((p) => p.key === key) ?? all[0]!;
}

export async function subscriptionFor(db: DbOrTx, orgId: string) {
  const [s] = await db.select().from(subscriptions).where(eq(subscriptions.orgId, orgId));
  return s ?? null;
}

/** The plan limit for an organization's metric, given its subscription. */
export async function limitFor(db: DbOrTx, orgId: string, metric: UsageMetric): Promise<number | null> {
  const sub = await subscriptionFor(db, orgId);
  if (sub?.status === "canceled") return 0;
  const plan = planByKey(sub?.planKey);
  return plan.limits[metric] ?? null;
}
