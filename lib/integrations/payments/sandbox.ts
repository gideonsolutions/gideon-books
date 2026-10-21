/**
 * The sandbox provider: a local, clearly labeled stand-in for a card
 * processor. Its checkout is a page on this server (/pay/<token>) that
 * moves no money; "paying" there sends a signed event, in Stripe's format,
 * through the same webhook pipeline and accounting a real provider uses.
 */
import { randomBytes } from "node:crypto";
import { Decimal } from "@/lib/money/decimal";
import type { CheckoutRequest, ConnectionConfig, PaymentProvider } from "./types";
import { parseStripeEvent } from "./stripe";
import { toMinor } from "./money";

export const SANDBOX_SIGNATURE_HEADER = "gideon-sandbox-signature";

export function sandboxId(prefix: string) {
  return `${prefix}_sandbox_${randomBytes(9).toString("hex")}`;
}

/** The sandbox fee for an amount (default 2.9% + 30 minor units, like a typical card price). */
export function sandboxFeeMinor(amountMinor: number, config: ConnectionConfig): number {
  const rate = Decimal.from(config.sandboxFeeRate ?? "0.029");
  const fixed = config.sandboxFeeFixedMinor ?? 30;
  const fee = Decimal.from(amountMinor).mul(rate).round(0, "half_up").add(fixed);
  const f = Number(fee.units);
  return Math.min(Math.max(f, 0), Math.max(amountMinor - 1, 0));
}

export const sandboxProvider: PaymentProvider = {
  name: "sandbox",
  label: "Sandbox (no real money)",
  signatureHeader: SANDBOX_SIGNATURE_HEADER,
  async createCheckout(req: CheckoutRequest) {
    // Validates the amount fits the currency; the sandbox has no remote session.
    void toMinor(req.amount, req.currency);
    // The token is assigned by the caller (payment_links.token); the URL uses it.
    return { url: "", sessionId: sandboxId("cs") };
  },
  parseEvent: parseStripeEvent,
  async feeFor(_pi, _secrets, event) {
    return event.feeMinor != null ? { feeMinor: event.feeMinor, currency: event.currency } : null;
  },
};
