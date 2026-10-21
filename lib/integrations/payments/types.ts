/** The provider abstraction for taking card payments against invoices. */
import type { Decimal } from "@/lib/money/decimal";

export interface ConnectionConfig {
  /** Where gross receipts land until the provider pays out (a clearing account). */
  clearingAccountId?: string | null;
  /** The bank account payouts arrive in. */
  bankAccountId?: string | null;
  /** Where processing fees are expensed. */
  feeAccountId?: string | null;
  /** Sandbox only: fee charged per payment, as a fraction and a fixed amount in minor units. */
  sandboxFeeRate?: string;
  sandboxFeeFixedMinor?: number;
}

export interface ConnectionSecrets {
  /** Stripe: the secret API key (sk_live_… / sk_test_…). */
  apiKey?: string;
  /** The webhook signing secret. */
  webhookSecret: string;
}

export interface CheckoutRequest {
  orgId: string;
  invoiceId: string;
  linkId: string;
  invoiceNumber: string;
  orgName: string;
  currency: string;
  amount: Decimal;
  customerEmail: string | null;
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutResult {
  url: string;
  sessionId: string | null;
}

export type NormalizedEvent =
  | {
      type: "payment_succeeded";
      paymentIntentId: string;
      amountMinor: number;
      currency: string;
      metadata: Record<string, string>;
      occurredAt: number;
      /** Fee in minor units if the event carries it (sandbox), else looked up. */
      feeMinor?: number | null;
    }
  | {
      type: "refund";
      paymentIntentId: string;
      chargeId: string;
      currency: string;
      refunds: { id: string; amountMinor: number }[];
      occurredAt: number;
    }
  | { type: "payout"; payoutId: string; amountMinor: number; currency: string; occurredAt: number; arrivalDate: number | null }
  | { type: "ignored"; reason: string };

export interface PaymentProvider {
  name: "stripe" | "sandbox";
  label: string;
  /** Header carrying the signature. */
  signatureHeader: string;
  createCheckout(req: CheckoutRequest, secrets: ConnectionSecrets, config: ConnectionConfig): Promise<CheckoutResult>;
  parseEvent(event: unknown): NormalizedEvent;
  /** The processing fee for a payment, in minor units of `currency`, or null if it cannot be known yet. */
  feeFor(paymentIntentId: string, secrets: ConnectionSecrets, event: NormalizedEvent & { type: "payment_succeeded" }): Promise<{ feeMinor: number; currency: string } | null>;
}
