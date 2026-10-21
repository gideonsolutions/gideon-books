/**
 * Stripe, through its REST API (no SDK): Checkout Sessions for invoices,
 * webhook events for payments, refunds and payouts, and the balance
 * transaction for each payment's fee. STRIPE_API_BASE overrides the API
 * address (tests point it at a local stub).
 */
import { IntegrationError } from "@/lib/errors";
import type { CheckoutRequest, ConnectionSecrets, NormalizedEvent, PaymentProvider } from "./types";
import { toMinor } from "./money";

function apiBase() {
  return (process.env.STRIPE_API_BASE ?? "https://api.stripe.com").replace(/\/$/, "");
}

async function stripeRequest<T>(method: "GET" | "POST", path: string, apiKey: string, form?: URLSearchParams): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${apiBase()}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        "stripe-version": "2024-06-20",
      },
      ...(form ? { body: form.toString() } : {}),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new IntegrationError(`Could not reach Stripe (${(e as Error).message}).`, "stripe_unreachable");
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) throw new IntegrationError(`Stripe refused the request: ${body.error?.message ?? res.status}.`, "stripe_error", { status: res.status });
  return body;
}

type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const metadataOf = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (v && typeof v === "object") for (const [k, x] of Object.entries(v as Obj)) if (typeof x === "string") out[k] = x;
  return out;
};

/** Normalize the subset of Stripe events the books act on. */
export function parseStripeEvent(event: unknown): NormalizedEvent {
  const e = event as Obj;
  const type = str(e?.type);
  const obj = ((e?.data as Obj | undefined)?.object ?? {}) as Obj;
  const created = num(e?.created) ?? Math.floor(Date.now() / 1000);
  switch (type) {
    case "checkout.session.completed": {
      if (str(obj.payment_status) !== "paid") return { type: "ignored", reason: "checkout completed without payment (asynchronous method still pending)" };
      const pi = str(obj.payment_intent);
      const amount = num(obj.amount_total);
      const currency = str(obj.currency);
      if (!pi || amount === null || !currency) return { type: "ignored", reason: "checkout session without a payment intent" };
      return { type: "payment_succeeded", paymentIntentId: pi, amountMinor: amount, currency: currency.toUpperCase(), metadata: metadataOf(obj.metadata), occurredAt: created, feeMinor: num(obj.sandbox_fee) };
    }
    case "payment_intent.succeeded": {
      const pi = str(obj.id);
      const amount = num(obj.amount_received) ?? num(obj.amount);
      const currency = str(obj.currency);
      if (!pi || amount === null || !currency) return { type: "ignored", reason: "payment intent without an amount" };
      return { type: "payment_succeeded", paymentIntentId: pi, amountMinor: amount, currency: currency.toUpperCase(), metadata: metadataOf(obj.metadata), occurredAt: created, feeMinor: num(obj.sandbox_fee) };
    }
    case "charge.refunded": {
      const pi = str(obj.payment_intent);
      const chargeId = str(obj.id);
      const currency = str(obj.currency);
      const list = ((obj.refunds as Obj | undefined)?.data ?? []) as Obj[];
      const refunds = list.map((r) => ({ id: str(r.id) ?? "", amountMinor: num(r.amount) ?? 0 })).filter((r) => r.id && r.amountMinor > 0);
      if (!pi || !chargeId || !currency) return { type: "ignored", reason: "refund without its payment" };
      if (!refunds.length) {
        const total = num(obj.amount_refunded);
        if (total && total > 0) refunds.push({ id: `${chargeId}:refunded:${total}`, amountMinor: total });
      }
      return { type: "refund", paymentIntentId: pi, chargeId, currency: currency.toUpperCase(), refunds, occurredAt: created };
    }
    case "payout.paid": {
      const id = str(obj.id);
      const amount = num(obj.amount);
      const currency = str(obj.currency);
      if (!id || amount === null || !currency) return { type: "ignored", reason: "payout without an amount" };
      return { type: "payout", payoutId: id, amountMinor: amount, currency: currency.toUpperCase(), occurredAt: created, arrivalDate: num(obj.arrival_date) };
    }
    default:
      return { type: "ignored", reason: `event type ${type ?? "unknown"} is not used by the books` };
  }
}

export const stripeProvider: PaymentProvider = {
  name: "stripe",
  label: "Stripe",
  signatureHeader: "stripe-signature",
  async createCheckout(req: CheckoutRequest, secrets: ConnectionSecrets) {
    if (!secrets.apiKey) throw new IntegrationError("The Stripe connection has no API key.", "stripe_not_configured");
    const f = new URLSearchParams();
    f.set("mode", "payment");
    f.set("success_url", req.successUrl);
    f.set("cancel_url", req.cancelUrl);
    f.set("line_items[0][quantity]", "1");
    f.set("line_items[0][price_data][currency]", req.currency.toLowerCase());
    f.set("line_items[0][price_data][unit_amount]", String(toMinor(req.amount, req.currency)));
    f.set("line_items[0][price_data][product_data][name]", `Invoice ${req.invoiceNumber} — ${req.orgName}`.slice(0, 250));
    for (const [k, v] of Object.entries({ orgId: req.orgId, invoiceId: req.invoiceId, linkId: req.linkId })) {
      f.set(`metadata[${k}]`, v);
      f.set(`payment_intent_data[metadata][${k}]`, v);
    }
    if (req.customerEmail) f.set("customer_email", req.customerEmail);
    const session = await stripeRequest<{ id: string; url: string }>("POST", "/v1/checkout/sessions", secrets.apiKey, f);
    if (!session.url) throw new IntegrationError("Stripe returned a checkout session without a URL.", "stripe_error");
    return { url: session.url, sessionId: session.id };
  },
  parseEvent: parseStripeEvent,
  async feeFor(paymentIntentId, secrets) {
    if (!secrets.apiKey) return null;
    const pi = await stripeRequest<{ latest_charge?: { balance_transaction?: { fee?: number; currency?: string } | string | null } | string | null }>(
      "GET",
      `/v1/payment_intents/${encodeURIComponent(paymentIntentId)}?expand[]=latest_charge.balance_transaction`,
      secrets.apiKey,
    );
    const charge = typeof pi.latest_charge === "object" ? pi.latest_charge : null;
    const bt = charge && typeof charge.balance_transaction === "object" ? charge.balance_transaction : null;
    if (!bt || typeof bt.fee !== "number" || !bt.currency) return null;
    return { feeMinor: bt.fee, currency: bt.currency.toUpperCase() };
  },
};
