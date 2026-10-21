/**
 * Driving the sandbox: the local checkout page's "Pay", and the buttons that
 * simulate a refund and a payout. Each builds the event a real provider
 * would send, signs it with the connection's secret, and hands it to the
 * same webhook pipeline — then processes it at once so the result shows
 * immediately (the queued job finds it already handled).
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { documents, payments } from "@/lib/db/schema/commerce";
import { organizations } from "@/lib/db/schema/core";
import { requirePermission, type Ctx } from "@/lib/context";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { Decimal } from "@/lib/money/decimal";
import { activePaymentConnection, connectionConfig, connectionSecrets, getPaymentConnection } from "./connections";
import { linkByToken } from "./links";
import { processWebhookEvent } from "./process";
import { receiveWebhook } from "./webhooks";
import { signPayload } from "./signature";
import { SANDBOX_SIGNATURE_HEADER, sandboxFeeMinor, sandboxId } from "./sandbox";
import { toMinor } from "./money";
import type { PaymentConnection } from "./connections";

async function deliver(conn: PaymentConnection, event: Record<string, unknown>) {
  const body = JSON.stringify(event);
  const headers = new Headers({ [SANDBOX_SIGNATURE_HEADER]: signPayload(body, connectionSecrets(conn).webhookSecret), "content-type": "application/json" });
  const r = await receiveWebhook(conn.id, body, headers);
  if (r.status !== 200) throw new ConflictError(`The sandbox event was refused: ${String(r.body.error ?? r.status)}.`, "sandbox_refused");
  if (!r.eventRowId) return { status: "processed" as const, detail: "duplicate" };
  return processWebhookEvent(r.eventRowId);
}

/** The customer "pays" on the sandbox checkout page. No money moves. */
export async function payThroughSandbox(token: string) {
  const link = await linkByToken(token);
  if (!link) throw new NotFoundError("The payment link");
  if (link.provider !== "sandbox") throw new ValidationError("This link is for a real provider.");
  if (link.status !== "open") throw new ConflictError(`This link is ${link.status}.`, "link_closed");
  const conn = await getPaymentConnection(getDb(), link.orgId, link.connectionId);
  if (conn.status !== "active") throw new ConflictError("The sandbox connection was disconnected.", "disconnected");
  const amountMinor = toMinor(Decimal.from(link.amount), link.currency);
  const pi = sandboxId("pi");
  const metadata = { orgId: link.orgId, invoiceId: link.documentId, linkId: link.id };
  return deliver(conn, {
    id: sandboxId("evt"),
    object: "event",
    type: "checkout.session.completed",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    data: {
      object: {
        id: link.providerSessionId ?? sandboxId("cs"),
        object: "checkout.session",
        payment_status: "paid",
        payment_intent: pi,
        amount_total: amountMinor,
        currency: link.currency.toLowerCase(),
        metadata,
        sandbox_fee: sandboxFeeMinor(amountMinor, connectionConfig(conn)),
      },
    },
  });
}

/** Simulate the provider refunding (part of) a sandbox payment. */
export async function simulateSandboxRefund(ctx: Ctx, paymentId: string, amount: string) {
  requirePermission(ctx, "payments.record");
  const db = getDb();
  const [p] = await db.select().from(payments).where(and(eq(payments.orgId, ctx.orgId), eq(payments.id, paymentId)));
  if (!p || p.provider !== "sandbox" || !p.providerRef) throw new ValidationError("Only payments taken through the sandbox can have a simulated refund.");
  const amt = Decimal.tryFrom(amount.replace(/,/g, ""));
  if (!amt || !amt.isPositive() || amt.gt(p.amount)) throw new ValidationError(`Refund between 0 and ${p.amount}.`, { amount: "Out of range." });
  const conn = await activeSandbox(ctx);
  const chargeId = `ch${p.providerRef.slice(2)}`;
  return deliver(conn, {
    id: sandboxId("evt"),
    object: "event",
    type: "charge.refunded",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    data: {
      object: {
        id: chargeId,
        object: "charge",
        payment_intent: p.providerRef,
        currency: p.currency.toLowerCase(),
        amount_refunded: toMinor(amt, p.currency),
        refunds: { data: [{ id: sandboxId("re"), amount: toMinor(amt, p.currency) }] },
      },
    },
  });
}

/** Simulate the provider paying out the clearing balance to the bank. */
export async function simulateSandboxPayout(ctx: Ctx, amount: string, currency?: string) {
  requirePermission(ctx, "payments.record");
  const conn = await activeSandbox(ctx);
  const amt = Decimal.tryFrom(amount.replace(/,/g, ""));
  if (!amt || !amt.isPositive()) throw new ValidationError("Enter the payout amount.", { amount: "Must be positive." });
  const cur = currency ?? ctx.org.baseCurrency;
  return deliver(conn, {
    id: sandboxId("evt"),
    object: "event",
    type: "payout.paid",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    data: { object: { id: sandboxId("po"), object: "payout", amount: toMinor(amt, cur), currency: cur.toLowerCase(), arrival_date: Math.floor(Date.now() / 1000) } },
  });
}

async function activeSandbox(ctx: Ctx): Promise<PaymentConnection> {
  const conn = await activePaymentConnection(getDb(), ctx.orgId);
  if (!conn || conn.provider !== "sandbox") throw new ValidationError("Connect the sandbox provider first.");
  return conn;
}

/** The invoice behind a sandbox link, for the public checkout page. */
export async function sandboxCheckoutView(token: string) {
  const link = await linkByToken(token);
  if (!link) return null;
  const db = getDb();
  const [doc] = await db.select().from(documents).where(and(eq(documents.orgId, link.orgId), eq(documents.id, link.documentId)));
  const [org] = await db.select({ name: organizations.name, isDemo: organizations.isDemo }).from(organizations).where(eq(organizations.id, link.orgId));
  return { link, invoiceNumber: doc?.number ?? "", orgName: org?.name ?? "", isDemo: !!org?.isDemo };
}
