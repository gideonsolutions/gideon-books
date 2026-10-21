/**
 * Hosted billing through Stripe Billing (fetch-based; no SDK). Used only
 * when HOSTED_MODE=true and these are set:
 *   STRIPE_BILLING_SECRET_KEY      — the platform's Stripe secret key
 *   STRIPE_BILLING_PRICE_ID        — the recurring price for the plan
 *   STRIPE_BILLING_WEBHOOK_SECRET  — the signing secret of /api/webhooks/billing
 * This is the platform charging for the hosted service; it is unrelated to
 * the payment providers an organization connects to collect from its own
 * customers.
 */
import { and, eq } from "drizzle-orm";
import { getDb, withTransaction } from "@/lib/db/client";
import { webhookEvents } from "@/lib/db/schema/core";
import { subscriptions, type SubscriptionStatus } from "@/lib/db/schema/hosted";
import { audit } from "@/lib/audit";
import { requirePermission, systemCtx, type Ctx } from "@/lib/context";
import { IntegrationError, ValidationError } from "@/lib/errors";
import { log } from "@/lib/log";
import { hostedMode } from "./metering";
import { plans } from "./plans";
import { SignatureError, verifyStripeSignature } from "./stripe-signature";

export const BILLING_PROVIDER = "stripe_billing";

export function billingConfig(): { configured: boolean; missing: string[] } {
  const need = ["STRIPE_BILLING_SECRET_KEY", "STRIPE_BILLING_PRICE_ID", "STRIPE_BILLING_WEBHOOK_SECRET"];
  const missing = need.filter((k) => !process.env[k]);
  return { configured: hostedMode() && missing.length === 0, missing };
}

async function stripe(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const key = process.env.STRIPE_BILLING_SECRET_KEY;
  if (!key) throw new IntegrationError("Billing is not configured on this server (STRIPE_BILLING_SECRET_KEY).", "billing_not_configured");
  let res: Response;
  try {
    res = await fetch(`https://api.stripe.com/v1/${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new IntegrationError(`Could not reach Stripe (${(e as Error).message}).`, "billing_unreachable");
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: { message?: string } };
  if (!res.ok) throw new IntegrationError(`Stripe refused the request: ${body.error?.message ?? res.status}.`, "billing_error");
  return body;
}

function appUrl(path: string) {
  return `${(process.env.APP_URL ?? "http://localhost:3200").replace(/\/$/, "")}${path}`;
}

/** Start a subscription: returns the Stripe-hosted checkout page to send the owner to. */
export async function createSubscriptionCheckout(ctx: Ctx): Promise<string> {
  requirePermission(ctx, "billing.manage");
  if (!hostedMode()) throw new ValidationError("This server is self-hosted; there is no subscription to buy.");
  if (ctx.org.isDemo) throw new ValidationError("A demonstration company cannot be subscribed.");
  const { configured, missing } = billingConfig();
  if (!configured) throw new IntegrationError(`Billing is not configured on this server (missing ${missing.join(", ")}).`, "billing_not_configured");
  const session = await stripe("checkout/sessions", {
    mode: "subscription",
    "line_items[0][price]": process.env.STRIPE_BILLING_PRICE_ID!,
    "line_items[0][quantity]": "1",
    client_reference_id: ctx.orgId,
    "metadata[orgId]": ctx.orgId,
    "subscription_data[metadata][orgId]": ctx.orgId,
    success_url: appUrl(`/o/${ctx.org.slug}/settings/billing?checkout=success`),
    cancel_url: appUrl(`/o/${ctx.org.slug}/settings/billing?checkout=canceled`),
  });
  await audit(getDb(), ctx, { action: "billing.checkout_started", entityType: "organization", entityId: ctx.orgId });
  return String(session.url);
}

/** The Stripe customer portal, to change the card or cancel. */
export async function createPortalSession(ctx: Ctx): Promise<string> {
  requirePermission(ctx, "billing.manage");
  const [sub] = await getDb().select().from(subscriptions).where(eq(subscriptions.orgId, ctx.orgId));
  if (!sub?.providerCustomerId) throw new ValidationError("There is no subscription to manage yet.");
  const session = await stripe("billing_portal/sessions", { customer: sub.providerCustomerId, return_url: appUrl(`/o/${ctx.org.slug}/settings/billing`) });
  return String(session.url);
}

const STATUS: Record<string, SubscriptionStatus> = {
  active: "active",
  trialing: "trialing",
  past_due: "past_due",
  unpaid: "past_due",
  canceled: "canceled",
  incomplete: "incomplete",
  incomplete_expired: "canceled",
  paused: "past_due",
};

interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

async function orgForSubscription(subscriptionId: string | null | undefined): Promise<string | null> {
  if (!subscriptionId) return null;
  const [s] = await getDb().select().from(subscriptions).where(eq(subscriptions.providerSubscriptionId, subscriptionId));
  return s?.orgId ?? null;
}

async function upsertSubscription(orgId: string, patch: Partial<typeof subscriptions.$inferInsert>) {
  const planKey = plans()[0]!.key;
  await getDb()
    .insert(subscriptions)
    .values({ orgId, planKey, status: patch.status ?? "incomplete", ...patch })
    .onConflictDoUpdate({ target: subscriptions.orgId, set: { ...patch, updatedAt: new Date() } });
}

/**
 * Verify, record (once) and apply a billing webhook. A replayed event id is
 * refused by the unique index on webhook_events; a bad signature or a stale
 * timestamp is refused before anything is stored.
 */
export async function handleBillingWebhook(rawBody: string, signature: string | null, now?: number): Promise<{ status: "processed" | "duplicate" | "ignored"; eventId: string }> {
  const secret = process.env.STRIPE_BILLING_WEBHOOK_SECRET;
  if (!secret) throw new IntegrationError("Billing webhooks are not configured on this server.", "billing_not_configured");
  try {
    verifyStripeSignature(rawBody, signature, secret, now !== undefined ? { now } : {});
  } catch (e) {
    throw new ValidationError(`Webhook signature rejected: ${(e as SignatureError).message}.`);
  }
  const event = JSON.parse(rawBody) as StripeEvent;
  if (!event?.id || !event.type) throw new ValidationError("Not a Stripe event.");
  const obj = event.data?.object ?? {};
  const meta = (obj.metadata ?? {}) as Record<string, string>;
  const subId = (obj.object === "subscription" ? obj.id : obj.subscription) as string | undefined;
  const orgId = (obj.client_reference_id as string | undefined) ?? meta.orgId ?? (await orgForSubscription(subId));

  const inserted = await getDb()
    .insert(webhookEvents)
    .values({ provider: BILLING_PROVIDER, eventId: event.id, eventType: event.type, payload: event as never, signatureVerified: true, orgId: orgId ?? null })
    .onConflictDoNothing()
    .returning();
  if (!inserted.length) return { status: "duplicate", eventId: event.id };

  let status: "processed" | "ignored" = "processed";
  try {
    if (!orgId) {
      status = "ignored";
    } else if (event.type === "checkout.session.completed") {
      await upsertSubscription(orgId, { status: "active", providerCustomerId: (obj.customer as string) ?? null, providerSubscriptionId: subId ?? null });
    } else if (event.type.startsWith("customer.subscription.")) {
      const s = event.type === "customer.subscription.deleted" ? "canceled" : (STATUS[String(obj.status)] ?? "incomplete");
      const periodEnd = typeof obj.current_period_end === "number" ? new Date(obj.current_period_end * 1000) : null;
      await upsertSubscription(orgId, {
        status: s,
        providerCustomerId: (obj.customer as string) ?? null,
        providerSubscriptionId: subId ?? null,
        currentPeriodEnd: periodEnd,
        ...(s === "canceled" ? { canceledAt: new Date() } : {}),
      });
    } else if (event.type === "invoice.payment_failed") {
      await upsertSubscription(orgId, { status: "past_due" });
    } else if (event.type === "invoice.paid") {
      await upsertSubscription(orgId, { status: "active" });
    } else {
      status = "ignored";
    }
    await getDb().update(webhookEvents).set({ status, processedAt: new Date() }).where(and(eq(webhookEvents.provider, BILLING_PROVIDER), eq(webhookEvents.eventId, event.id)));
    if (orgId && status === "processed") {
      await withTransaction(async (tx) => {
        const ctx = await systemCtx(orgId, "webhook: billing", "webhook", tx);
        await audit(tx, ctx, { action: "billing.subscription_updated", entityType: "organization", entityId: orgId, metadata: { event: event.type, eventId: event.id } });
      });
    }
  } catch (e) {
    // Forget the event so Stripe's retry processes it again.
    await getDb().delete(webhookEvents).where(and(eq(webhookEvents.provider, BILLING_PROVIDER), eq(webhookEvents.eventId, event.id)));
    log.error("billing webhook failed", { eventId: event.id, error: (e as Error).message });
    throw e;
  }
  return { status, eventId: event.id };
}
