import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { documents, payments } from "@/lib/db/schema/commerce";
import { webhookEvents } from "@/lib/db/schema/core";
import { issueDocument, saveDraft } from "@/lib/commerce/documents";
import { itemBalance } from "@/lib/commerce/open-items";
import { connectSandbox, connectStripe, connectionSecrets, getPaymentConnection } from "@/lib/integrations/payments/connections";
import { createPaymentLink } from "@/lib/integrations/payments/links";
import { receiveWebhook } from "@/lib/integrations/payments/webhooks";
import { processWebhookEvent } from "@/lib/integrations/payments/process";
import { payThroughSandbox, simulateSandboxPayout, simulateSandboxRefund } from "@/lib/integrations/payments/sandbox-sim";
import { signPayload, verifySignature, SignatureError } from "@/lib/integrations/payments/signature";
import { parseStripeEvent } from "@/lib/integrations/payments/stripe";
import { Decimal } from "@/lib/money/decimal";
import { balance, customer, rejectsWith, setupOrg, type TestOrg } from "../helpers";

let t: TestOrg;
beforeAll(async () => {
  t = await setupOrg();
});
afterEach(() => vi.unstubAllGlobals());

describe("webhook signatures", () => {
  const secret = "whsec_test_0123456789abcdef";
  const body = JSON.stringify({ id: "evt_1", type: "payout.paid" });
  it("accepts a valid signature and refuses a wrong one or a stale timestamp", () => {
    const now = 1_800_000_000;
    expect(verifySignature(signPayload(body, secret, now), body, secret, { nowSeconds: now + 10 }).timestamp).toBe(now);
    expect(() => verifySignature(signPayload(body, "whsec_other_secret_value", now), body, secret, { nowSeconds: now })).toThrow(SignatureError);
    expect(() => verifySignature(signPayload(body + " ", secret, now), body, secret, { nowSeconds: now })).toThrow(/does not match/);
    expect(() => verifySignature(signPayload(body, secret, now), body, secret, { nowSeconds: now + 301 })).toThrow(/too old/);
    expect(() => verifySignature(null, body, secret)).toThrow(/missing/);
  });
});

describe("Stripe adapter", () => {
  it("creates a checkout session through the API with the invoice's metadata", async () => {
    const o = await setupOrg({ name: "Stripe Co" });
    const conn = await connectStripe(o.ctx, { apiKey: "sk_test_abcdefghijklmnop", webhookSecret: "whsec_abcdefghijklmnop", bankAccountId: await o.acct("1000") });
    expect(connectionSecrets(conn).apiKey).toBe("sk_test_abcdefghijklmnop");
    expect(conn.secretEnc).not.toContain("sk_test");
    const c = await customer(o.ctx, "Card Buyer", { email: "buyer@example.test" });
    const inv = await issueDocument(o.ctx, (await saveDraft(o.ctx, { kind: "invoice", contactId: c.id, issueDate: "2026-04-01", lines: [{ unitPrice: "123.45" }] })).id);
    const calls: { url: string; body: string; auth: string }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body), auth: String((init.headers as Record<string, string>).authorization) });
      return new Response(JSON.stringify({ id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" }), { status: 200 });
    });
    const link = await createPaymentLink(o.ctx, inv.id);
    expect(link.url).toBe("https://checkout.stripe.com/c/pay/cs_test_1");
    expect(calls[0]!.url).toMatch(/\/v1\/checkout\/sessions$/);
    expect(calls[0]!.auth).toBe("Bearer sk_test_abcdefghijklmnop");
    const form = new URLSearchParams(calls[0]!.body);
    expect(form.get("line_items[0][price_data][unit_amount]")).toBe("12345");
    expect(form.get("metadata[invoiceId]")).toBe(inv.id);
    expect(form.get("payment_intent_data[metadata][orgId]")).toBe(o.orgId);
  });

  it("normalizes payment, refund and payout events", () => {
    expect(parseStripeEvent({ type: "checkout.session.completed", created: 1, data: { object: { payment_status: "paid", payment_intent: "pi_1", amount_total: 500, currency: "usd", metadata: { invoiceId: "x" } } } })).toMatchObject({
      type: "payment_succeeded",
      paymentIntentId: "pi_1",
      amountMinor: 500,
      currency: "USD",
    });
    expect(parseStripeEvent({ type: "checkout.session.completed", data: { object: { payment_status: "unpaid" } } }).type).toBe("ignored");
    expect(parseStripeEvent({ type: "charge.refunded", data: { object: { id: "ch_1", payment_intent: "pi_1", currency: "usd", refunds: { data: [{ id: "re_1", amount: 200 }] } } } })).toMatchObject({ type: "refund", refunds: [{ id: "re_1", amountMinor: 200 }] });
    expect(parseStripeEvent({ type: "payout.paid", data: { object: { id: "po_1", amount: 1000, currency: "usd" } } })).toMatchObject({ type: "payout", amountMinor: 1000 });
    expect(parseStripeEvent({ type: "customer.created", data: { object: {} } }).type).toBe("ignored");
  });

  it("looks up the fee on the balance transaction when processing a real Stripe payment", async () => {
    const o = await setupOrg({ name: "Stripe Fees" });
    const conn = await connectStripe(o.ctx, { apiKey: "sk_test_feesfeesfeesfees", webhookSecret: "whsec_feesfeesfeesfees", bankAccountId: await o.acct("1000") });
    const c = await customer(o.ctx, "Fee Buyer");
    const inv = await issueDocument(o.ctx, (await saveDraft(o.ctx, { kind: "invoice", contactId: c.id, issueDate: "2026-04-01", lines: [{ unitPrice: "100" }] })).id);
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ id: "pi_fee", latest_charge: { id: "ch_fee", balance_transaction: { fee: 320, currency: "usd" } } }), { status: 200 }));
    const body = JSON.stringify({ id: "evt_fee_1", type: "payment_intent.succeeded", created: Math.floor(Date.UTC(2026, 3, 2) / 1000), data: { object: { id: "pi_fee", amount_received: 10000, currency: "usd", metadata: { orgId: o.orgId, invoiceId: inv.id } } } });
    const r = await receiveWebhook(conn.id, body, new Headers({ "stripe-signature": signPayload(body, "whsec_feesfeesfeesfees") }));
    expect(r.status).toBe(200);
    const out = await processWebhookEvent(r.eventRowId!);
    expect(out.status).toBe("processed");
    expect(await balance(o.orgId, await o.acct("payment_fees"))).toBe("3.20");
    expect(await balance(o.orgId, await o.acct("payment_clearing"))).toBe("96.80");
    const [d] = await getDb().select().from(documents).where(eq(documents.id, inv.id));
    expect(d!.status).toBe("paid");
  });
});

describe("provider webhook pipeline and accounting (sandbox)", () => {
  it("refuses bad signatures and replays, and posts gross, fee, refund and payout idempotently", async () => {
    const conn = await connectSandbox(t.ctx, { bankAccountId: await t.acct("1000") });
    const c = await customer(t.ctx, "Online Payer");
    const inv = await issueDocument(t.ctx, (await saveDraft(t.ctx, { kind: "invoice", contactId: c.id, issueDate: "2026-04-01", lines: [{ unitPrice: "200" }] })).id);
    const link = await createPaymentLink(t.ctx, inv.id);
    expect(link.url).toMatch(new RegExp(`/pay/${link.token}$`));

    // A forged event is refused before it is recorded.
    const forged = JSON.stringify({ id: "evt_forged", type: "payout.paid", data: { object: { id: "po_x", amount: 999999, currency: "usd" } } });
    const bad = await receiveWebhook(conn.id, forged, new Headers({ "gideon-sandbox-signature": signPayload(forged, "whsec_not_the_secret") }));
    expect(bad.status).toBe(400);
    const stale = await receiveWebhook(conn.id, forged, new Headers({ "gideon-sandbox-signature": signPayload(forged, connectionSecrets(conn).webhookSecret, Math.floor(Date.now() / 1000) - 3600) }));
    expect(stale.status).toBe(400);
    expect(await getDb().select().from(webhookEvents).where(eq(webhookEvents.eventId, "evt_forged"))).toHaveLength(0);

    const out = await payThroughSandbox(link.token);
    expect(out.status).toBe("processed");
    // Gross 200.00 into clearing; sandbox fee 2.9% + 0.30 = 6.10 expensed; clearing holds 193.90.
    expect(await balance(t.orgId, await t.acct("payment_clearing"))).toBe("193.90");
    expect(await balance(t.orgId, await t.acct("payment_fees"))).toBe("6.10");
    const [paid] = await getDb().select().from(documents).where(eq(documents.id, inv.id));
    expect(paid!.status).toBe("paid");

    // Re-delivering the same event (a replay) and re-processing it change nothing.
    const [ev] = await getDb().select().from(webhookEvents).where(and(eq(webhookEvents.orgId, t.orgId), eq(webhookEvents.eventType, "checkout.session.completed")));
    const body = JSON.stringify(ev!.payload);
    const replay = await receiveWebhook(conn.id, body, new Headers({ "gideon-sandbox-signature": signPayload(body, connectionSecrets(conn).webhookSecret) }));
    expect(replay.body.duplicate).toBe(true);
    await getDb().update(webhookEvents).set({ status: "failed" }).where(eq(webhookEvents.id, ev!.id));
    expect((await processWebhookEvent(ev!.id)).detail).toMatch(/Already recorded/);
    expect(await balance(t.orgId, await t.acct("payment_clearing"))).toBe("193.90");
    const pays = await getDb().select().from(payments).where(and(eq(payments.orgId, t.orgId), eq(payments.provider, "sandbox")));
    expect(pays).toHaveLength(1);

    // A partial refund reopens the invoice by the refunded amount.
    await simulateSandboxRefund(t.ctx, pays[0]!.id, "50");
    expect(await balance(t.orgId, await t.acct("payment_clearing"))).toBe("143.90");
    expect((await itemBalance(getDb(), t.orgId, inv.id)).txn.toFixed(2)).toBe("50.00");
    const [reopened] = await getDb().select().from(documents).where(eq(documents.id, inv.id));
    expect(reopened!.status).toBe("partially_paid");

    // The payout moves what is in clearing to the bank.
    const bankBefore = await balance(t.orgId, await t.acct("1000"));
    await simulateSandboxPayout(t.ctx, "143.90");
    expect(await balance(t.orgId, await t.acct("payment_clearing"))).toBe("0.00");
    expect(Decimal.from(await balance(t.orgId, await t.acct("1000"))).sub(bankBefore).toFixed(2)).toBe("143.90");

    // The link is paid, so it cannot be paid twice.
    await rejectsWith(payThroughSandbox(link.token), "link_closed");
    expect((await getPaymentConnection(getDb(), t.orgId, conn.id)).lastError).toBeNull();
  });

  it("only lets demonstration companies use the sandbox", async () => {
    const o = await setupOrg({ name: "Demo Co", isDemo: true });
    await rejectsWith(connectStripe(o.ctx, { apiKey: "sk_test_abcdefghijklmnop", webhookSecret: "whsec_abcdefghijklmnop" }), "validation_failed");
  });
});
