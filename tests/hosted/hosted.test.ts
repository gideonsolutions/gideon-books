import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { subscriptions } from "@/lib/db/schema/hosted";
import { assertWithinLimit, recordUsage, usageThisMonth } from "@/lib/hosted/metering";
import { limitFor } from "@/lib/hosted/plans";
import { handleBillingWebhook } from "@/lib/hosted/billing";
import { signStripePayload, verifyStripeSignature } from "@/lib/hosted/stripe-signature";
import { listAccounts } from "@/lib/ledger/accounts";
import { buildOrgExport } from "@/lib/ops/export";
import { queueEmail, setEmailProviderForTests } from "@/lib/email/send";
import { rejectsWith, setupOrg, type TestOrg } from "../helpers";

let t: TestOrg;
const SECRET = "whsec_test_secret_for_billing";

beforeAll(async () => {
  t = await setupOrg();
});

afterEach(() => {
  delete process.env.HOSTED_MODE;
  delete process.env.HOSTED_PLANS;
  delete process.env.STRIPE_BILLING_WEBHOOK_SECRET;
});

const plans = (emails: number) =>
  JSON.stringify([{ key: "pro", name: "Pro", monthlyPriceCents: 1000, limits: { bank_feed_syncs: 10, documents_processed: 10, storage_bytes: 1000000, emails_sent: emails } }]);

describe("hosted metering", () => {
  it("never meters or limits a self-hosted server", async () => {
    await recordUsage(getDb(), t.orgId, "emails_sent", 5);
    expect(await usageThisMonth(getDb(), t.orgId, "emails_sent")).toBe(0);
    await assertWithinLimit(getDb(), t.orgId, "emails_sent", 1_000_000);
  });

  it("enforces plan limits in hosted mode, and a canceled subscription stops cost-bearing services only", async () => {
    process.env.HOSTED_MODE = "true";
    process.env.HOSTED_PLANS = plans(2);
    await recordUsage(getDb(), t.orgId, "emails_sent", 2);
    await rejectsWith(assertWithinLimit(getDb(), t.orgId, "emails_sent", 1), "usage_limit_reached");
    // Email delivery through a real provider is refused at the limit; the outbox (no delivery) is not metered.
    setEmailProviderForTests({ name: "test-smtp", delivers: true, send: async () => ({ providerMessageId: "x" }) });
    try {
      await rejectsWith(queueEmail(getDb(), t.ctx, { to: "someone@example.com", subject: "x", text: "y" }), "usage_limit_reached");
    } finally {
      setEmailProviderForTests(null);
    }
    await getDb().insert(subscriptions).values({ orgId: t.orgId, planKey: "pro", status: "canceled" });
    expect(await limitFor(getDb(), t.orgId, "bank_feed_syncs")).toBe(0);
    await rejectsWith(assertWithinLimit(getDb(), t.orgId, "documents_processed", 1), "usage_limit_reached");
    // Reading the books and the full export keep working.
    expect((await listAccounts(getDb(), t.orgId)).length).toBeGreaterThan(10);
    const { manifest } = await buildOrgExport(t.orgId);
    expect(manifest.tables.find((x) => x.name === "accounts")!.rows).toBeGreaterThan(10);
    await getDb().delete(subscriptions).where(eq(subscriptions.orgId, t.orgId));
  });
});

describe("billing webhooks", () => {
  const event = (id: string, type: string, object: Record<string, unknown>) => JSON.stringify({ id, type, data: { object } });

  it("verifies signatures and timestamps", () => {
    const body = event("evt_1", "x", {});
    const header = signStripePayload(body, SECRET, 1_800_000_000);
    expect(() => verifyStripeSignature(body, header, SECRET, { now: 1_800_000_010 })).not.toThrow();
    expect(() => verifyStripeSignature(body, header, SECRET, { now: 1_800_000_400 })).toThrow(/tolerance/);
    expect(() => verifyStripeSignature(body + " ", header, SECRET, { now: 1_800_000_010 })).toThrow(/does not match/);
    expect(() => verifyStripeSignature(body, header, "whsec_other", { now: 1_800_000_010 })).toThrow(/does not match/);
    expect(() => verifyStripeSignature(body, null, SECRET)).toThrow(/missing/);
  });

  it("activates, refuses replays, and cancels", async () => {
    process.env.HOSTED_MODE = "true";
    process.env.STRIPE_BILLING_WEBHOOK_SECRET = SECRET;
    const now = Math.floor(Date.now() / 1000);
    const completed = event("evt_checkout_1", "checkout.session.completed", { object: "checkout.session", client_reference_id: t.orgId, customer: "cus_1", subscription: "sub_1" });
    expect((await handleBillingWebhook(completed, signStripePayload(completed, SECRET, now))).status).toBe("processed");
    const [s] = await getDb().select().from(subscriptions).where(eq(subscriptions.orgId, t.orgId));
    expect([s!.status, s!.providerCustomerId, s!.providerSubscriptionId]).toEqual(["active", "cus_1", "sub_1"]);
    expect((await handleBillingWebhook(completed, signStripePayload(completed, SECRET, now))).status).toBe("duplicate");
    await rejectsWith(handleBillingWebhook(completed, signStripePayload(completed, "whsec_wrong", now)), "validation_failed");
    const deleted = event("evt_sub_deleted", "customer.subscription.deleted", { object: "subscription", id: "sub_1", status: "canceled", customer: "cus_1" });
    await handleBillingWebhook(deleted, signStripePayload(deleted, SECRET, now));
    const [s2] = await getDb().select().from(subscriptions).where(eq(subscriptions.orgId, t.orgId));
    expect(s2!.status).toBe("canceled");
  });
});
