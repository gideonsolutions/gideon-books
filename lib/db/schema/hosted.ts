/**
 * Hosted offering (only active when HOSTED_MODE=true): plans are
 * configuration (lib/hosted/plans.ts), subscriptions record each
 * organization's billing state, and usage events meter the services that
 * cost money to run. The accounting core never depends on these tables.
 */
import { bigint, index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, ts, updatedAt } from "./_columns";
import { organizations } from "./core";

export const USAGE_METRICS = ["bank_feed_syncs", "documents_processed", "storage_bytes", "emails_sent"] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number];

/** One metered event. Monthly usage is the sum per organization and metric. */
export const usageEvents = pgTable(
  "usage_events",
  {
    id: id(),
    orgId: uuid("org_id").notNull(),
    metric: text("metric", { enum: USAGE_METRICS }).notNull(),
    quantity: bigint("quantity", { mode: "number" }).notNull(),
    ref: text("ref"),
    metadata: jsonb("metadata"),
    occurredAt: createdAt(),
  },
  (t) => [index("usage_events_org_metric_idx").on(t.orgId, t.metric, t.occurredAt)],
);

export const SUBSCRIPTION_STATUSES = ["trialing", "active", "past_due", "canceled", "incomplete"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** An organization's hosted subscription. No row means the organization is on its trial. */
export const subscriptions = pgTable("subscriptions", {
  orgId: uuid("org_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  planKey: text("plan_key").notNull(),
  status: text("status", { enum: SUBSCRIPTION_STATUSES }).notNull(),
  provider: text("provider").notNull().default("stripe"),
  providerCustomerId: text("provider_customer_id"),
  providerSubscriptionId: text("provider_subscription_id"),
  currentPeriodEnd: ts("current_period_end"),
  trialEndsAt: ts("trial_ends_at"),
  canceledAt: ts("canceled_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
