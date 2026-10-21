/**
 * The accounting for provider events (docs/integrations/payments.md):
 *
 *  payment succeeded → a customer payment of the GROSS amount into the
 *     connection's clearing account, applied to the invoice, with the
 *     processor's fee recorded on it (fee expense; the clearing account
 *     holds gross − fee, which is what the provider will pay out);
 *  refund → a refund to the customer out of the clearing account, applied to
 *     the original payment (the invoice reopens by the refunded amount; issue
 *     a credit note if the sale itself is undone);
 *  payout → a transfer from the clearing account to the bank account.
 *
 * Every step is idempotent: payments by provider reference, payouts by an
 * idempotency key on the entry, events by their recorded status.
 */
import { and, desc, eq } from "drizzle-orm";
import { getDb, withTransaction, type Tx } from "@/lib/db/client";
import { integrationConnections, webhookEvents } from "@/lib/db/schema/core";
import { accounts } from "@/lib/db/schema/ledger";
import { documents, payments, settlements } from "@/lib/db/schema/commerce";
import { paymentLinks } from "@/lib/db/schema/sales";
import { systemCtx, type Ctx } from "@/lib/context";
import { ValidationError } from "@/lib/errors";
import { Decimal } from "@/lib/money/decimal";
import { minorUnits } from "@/lib/money/currency";
import { todayIn } from "@/lib/dates";
import { recordPayment } from "@/lib/commerce/payments";
import { itemBalance, loadOpenItem, openAmount } from "@/lib/commerce/open-items";
import { reverseSettlement, settle } from "@/lib/commerce/settlements";
import { postEntry } from "@/lib/ledger/posting";
import { systemAccountId } from "@/lib/ledger/accounts";
import { resolveRate } from "@/lib/fx/rates";
import { audit } from "@/lib/audit";
import { connectionConfig, connectionSecrets, providerFor, type PaymentConnection } from "./connections";
import { fromMinor } from "./money";
import type { ConnectionConfig, NormalizedEvent } from "./types";

type Outcome = { status: "processed" | "ignored"; detail: string };

class NotOurs extends Error {}

function dateOf(ctx: Ctx, seconds: number) {
  return todayIn(ctx.org.timezone, new Date(seconds * 1000));
}

async function clearingAccount(tx: Tx, ctx: Ctx, cfg: ConnectionConfig) {
  const id = cfg.clearingAccountId ?? (await systemAccountId(tx, ctx.orgId, "payment_clearing"));
  const [a] = await tx.select().from(accounts).where(and(eq(accounts.orgId, ctx.orgId), eq(accounts.id, id)));
  if (!a) throw new ValidationError("The connection's clearing account no longer exists.");
  return a;
}

async function handlePayment(tx: Tx, ctx: Ctx, conn: PaymentConnection, ev: NormalizedEvent & { type: "payment_succeeded" }, fee: { feeMinor: number; currency: string } | null): Promise<Outcome> {
  if (ev.metadata.orgId && ev.metadata.orgId !== conn.orgId) throw new NotOurs("The event is for another organization.");
  const invoiceId = ev.metadata.invoiceId;
  if (!invoiceId) return { status: "ignored", detail: "A payment not started from a Gideon Books invoice; record it by hand if it belongs in the books." };
  const [prior] = await tx
    .select()
    .from(payments)
    .where(and(eq(payments.orgId, conn.orgId), eq(payments.provider, conn.provider), eq(payments.providerRef, ev.paymentIntentId)));
  if (prior) return { status: "processed", detail: `Already recorded as ${prior.number}.` };
  const [inv] = await tx.select().from(documents).where(and(eq(documents.orgId, conn.orgId), eq(documents.id, invoiceId)));
  if (!inv || inv.kind !== "invoice") throw new NotOurs("The event names an invoice that does not exist here.");
  if (inv.currency !== ev.currency) throw new ValidationError(`The provider took ${ev.currency} for an invoice in ${inv.currency}; record this payment by hand.`);
  const cfg = connectionConfig(conn);
  const clearing = await clearingAccount(tx, ctx, cfg);
  const amount = fromMinor(ev.amountMinor, ev.currency);
  let feeAmount = fee && fee.currency === ev.currency ? fromMinor(fee.feeMinor, fee.currency) : Decimal.ZERO;
  if (feeAmount.gte(amount)) feeAmount = Decimal.ZERO;
  const sameCurrency = (clearing.currency ?? ctx.org.baseCurrency) === ev.currency;
  const date = dateOf(ctx, ev.occurredAt);
  let allocation = Decimal.ZERO;
  if (inv.status === "issued" || inv.status === "partially_paid") {
    const open = (await itemBalance(tx, ctx.orgId, inv.id)).txn;
    allocation = Decimal.min(open, amount);
  }
  const feeAccountId = cfg.feeAccountId ?? (await systemAccountId(tx, ctx.orgId, "payment_fees"));
  const pay = await recordPayment(
    ctx,
    {
      kind: "customer_payment",
      contactId: inv.contactId!,
      paymentDate: date < (inv.postingDate ?? inv.issueDate) ? (inv.postingDate ?? inv.issueDate) : date,
      accountId: clearing.id,
      currency: ev.currency,
      amount: amount.toString(),
      feeAmount: sameCurrency && feeAmount.isPositive() ? feeAmount.toString() : null,
      feeAccountId,
      method: "provider",
      reference: ev.paymentIntentId,
      memo: `${providerFor(conn).label} payment for ${inv.number}`,
      allocations: allocation.isPositive() ? [{ itemType: "document", itemId: inv.id, amount: allocation.toString() }] : [],
      provider: conn.provider,
      providerRef: ev.paymentIntentId,
    },
    { tx, idempotencyKey: `${conn.provider}:${ev.paymentIntentId}` },
  );
  if (!sameCurrency && feeAmount.isPositive()) {
    // The clearing account is in another currency: the fee is its own entry at the payment's rate.
    const rate = Decimal.from(pay.fxRate);
    const feeBase = feeAmount.mul(rate).round(minorUnits(ctx.org.baseCurrency), "half_up");
    await postEntry(tx, ctx, {
      kind: "payment_provider",
      entryDate: pay.paymentDate,
      description: `${providerFor(conn).label} fee on ${inv.number}`,
      sourceType: "payment",
      sourceId: pay.id,
      idempotencyKey: `${conn.provider}:fee:${ev.paymentIntentId}`,
      lines: [
        { accountId: feeAccountId, amount: feeAmount.toString(), currency: ev.currency, fxRate: rate.toString(), contactId: inv.contactId },
        { accountId: clearing.id, amount: feeBase.neg().toString(), currency: clearing.currency ?? ctx.org.baseCurrency },
      ],
    });
  }
  if (ev.metadata.linkId) {
    await tx
      .update(paymentLinks)
      .set({ status: "paid", paidAt: new Date() })
      .where(and(eq(paymentLinks.orgId, conn.orgId), eq(paymentLinks.id, ev.metadata.linkId)));
  }
  return { status: "processed", detail: `Recorded payment ${pay.number} of ${amount.toString()} ${ev.currency}${feeAmount.isPositive() ? ` (fee ${feeAmount.toString()})` : ""}.` };
}

/**
 * Free `need` of a payment's credit by undoing its most recent applications
 * (and re-applying whatever part of the last one is not needed).
 */
async function freeCredit(tx: Tx, ctx: Ctx, paymentId: string, need: Decimal, date: string, reason: string) {
  const info = await loadOpenItem(tx, ctx.orgId, { type: "payment", id: paymentId });
  const open = openAmount(info, await itemBalance(tx, ctx.orgId, paymentId));
  let remaining = need.sub(open);
  if (!remaining.isPositive()) return;
  const apps = await tx
    .select()
    .from(settlements)
    .where(and(eq(settlements.orgId, ctx.orgId), eq(settlements.creditItemId, paymentId), eq(settlements.status, "active")))
    .orderBy(desc(settlements.settlementDate), desc(settlements.createdAt));
  for (const s of apps) {
    if (!remaining.isPositive()) break;
    const amt = Decimal.from(s.amount);
    await reverseSettlement(tx, ctx, s.id, { date: date < s.settlementDate ? s.settlementDate : date, reason });
    if (amt.gt(remaining)) {
      await settle(tx, ctx, { debit: { type: s.debitItemType, id: s.debitItemId }, credit: { type: "payment", id: paymentId }, amount: amt.sub(remaining).toString(), date: date < s.settlementDate ? s.settlementDate : date });
      remaining = Decimal.ZERO;
    } else remaining = remaining.sub(amt);
  }
}

async function handleRefund(tx: Tx, ctx: Ctx, conn: PaymentConnection, ev: NormalizedEvent & { type: "refund" }): Promise<Outcome> {
  const [orig] = await tx
    .select()
    .from(payments)
    .where(and(eq(payments.orgId, conn.orgId), eq(payments.provider, conn.provider), eq(payments.providerRef, ev.paymentIntentId), eq(payments.kind, "customer_payment")));
  // The payment's own event may not have been processed yet; failing lets the job retry.
  if (!orig) throw new ValidationError(`No recorded payment ${ev.paymentIntentId} to refund yet.`);
  const cfg = connectionConfig(conn);
  const clearing = await clearingAccount(tx, ctx, cfg);
  const date = dateOf(ctx, ev.occurredAt) < orig.paymentDate ? orig.paymentDate : dateOf(ctx, ev.occurredAt);
  const done: string[] = [];
  for (const r of ev.refunds) {
    const [already] = await tx
      .select()
      .from(payments)
      .where(and(eq(payments.orgId, conn.orgId), eq(payments.provider, conn.provider), eq(payments.providerRef, r.id)));
    if (already) continue;
    const amount = fromMinor(r.amountMinor, ev.currency);
    await freeCredit(tx, ctx, orig.id, amount, date, `Refunded through ${providerFor(conn).label}`);
    const refund = await recordPayment(
      ctx,
      {
        kind: "customer_refund",
        contactId: orig.contactId,
        paymentDate: date,
        accountId: clearing.id,
        currency: ev.currency,
        amount: amount.toString(),
        method: "provider",
        reference: r.id,
        memo: `${providerFor(conn).label} refund of ${orig.number}`,
        allocations: [{ itemType: "payment", itemId: orig.id, amount: amount.toString() }],
        provider: conn.provider,
        providerRef: r.id,
      },
      { tx, idempotencyKey: `${conn.provider}:${r.id}` },
    );
    done.push(`${refund.number} (${amount.toString()} ${ev.currency})`);
  }
  return { status: "processed", detail: done.length ? `Recorded refund ${done.join(", ")}.` : "Refunds already recorded." };
}

async function handlePayout(tx: Tx, ctx: Ctx, conn: PaymentConnection, ev: NormalizedEvent & { type: "payout" }): Promise<Outcome> {
  const cfg = connectionConfig(conn);
  if (ev.amountMinor <= 0) return { status: "ignored", detail: "A payout of zero or less (the provider debited the bank); record it by hand." };
  if (!cfg.bankAccountId) throw new ValidationError("Choose the bank account payouts arrive in (Settings → Integrations), then retry this event.");
  const clearing = await clearingAccount(tx, ctx, cfg);
  const amount = fromMinor(ev.amountMinor, ev.currency);
  const date = dateOf(ctx, ev.arrivalDate ?? ev.occurredAt);
  const foreign = ev.currency !== ctx.org.baseCurrency;
  const rate = foreign ? await resolveRate(tx, ctx, ev.currency, date) : null;
  const fx = rate ? { fxRate: rate.rate.toString(), exchangeRateId: rate.exchangeRateId } : {};
  const posted = await postEntry(tx, ctx, {
    kind: "payment_provider",
    entryDate: date,
    description: `${providerFor(conn).label} payout ${ev.payoutId}`,
    sourceType: "payment_provider_payout",
    sourceRef: ev.payoutId,
    idempotencyKey: `payout:${conn.provider}:${ev.payoutId}`,
    lines: [
      { accountId: cfg.bankAccountId, amount: amount.toString(), currency: ev.currency, ...fx, description: `Payout ${ev.payoutId}` },
      { accountId: clearing.id, amount: amount.neg().toString(), currency: ev.currency, ...fx, description: `Payout ${ev.payoutId}` },
    ],
  });
  return { status: "processed", detail: posted.created ? `Recorded payout as entry #${posted.entry.entryNumber}.` : "Payout already recorded." };
}

/** Process one recorded event (the payments.process_event job). Safe to run more than once. */
export async function processWebhookEvent(eventRowId: string): Promise<Outcome> {
  const db = getDb();
  const [row] = await db.select().from(webhookEvents).where(eq(webhookEvents.id, eventRowId));
  if (!row) return { status: "ignored", detail: "event not found" };
  if (row.status === "processed" || row.status === "ignored") return { status: row.status, detail: "already handled" };
  const [conn] = row.connectionId ? await db.select().from(integrationConnections).where(eq(integrationConnections.id, row.connectionId)) : [];
  if (!conn) {
    await db.update(webhookEvents).set({ status: "ignored", processedAt: new Date(), error: "connection no longer exists" }).where(eq(webhookEvents.id, row.id));
    return { status: "ignored", detail: "connection no longer exists" };
  }
  const provider = providerFor(conn);
  const ev = provider.parseEvent(row.payload);
  if (ev.type === "ignored") {
    await db.update(webhookEvents).set({ status: "ignored", processedAt: new Date(), error: ev.reason }).where(eq(webhookEvents.id, row.id));
    return { status: "ignored", detail: ev.reason };
  }
  let fee: { feeMinor: number; currency: string } | null = null;
  if (ev.type === "payment_succeeded") {
    fee = ev.feeMinor != null ? { feeMinor: ev.feeMinor, currency: ev.currency } : await provider.feeFor(ev.paymentIntentId, connectionSecrets(conn), ev).catch(() => null);
  }
  const ctx = await systemCtx(conn.orgId, `${provider.label} webhook`, "webhook");
  try {
    const outcome = await withTransaction(async (tx) => {
      const [locked] = await tx.select().from(webhookEvents).where(eq(webhookEvents.id, row.id)).for("update");
      if (!locked || locked.status === "processed" || locked.status === "ignored") return { status: "processed" as const, detail: "already handled" };
      const out =
        ev.type === "payment_succeeded" ? await handlePayment(tx, ctx, conn, ev, fee) : ev.type === "refund" ? await handleRefund(tx, ctx, conn, ev) : await handlePayout(tx, ctx, conn, ev);
      await tx.update(webhookEvents).set({ status: out.status, processedAt: new Date(), error: out.status === "ignored" ? out.detail : null }).where(eq(webhookEvents.id, row.id));
      await tx.update(integrationConnections).set({ lastSyncedAt: new Date(), lastError: null }).where(eq(integrationConnections.id, conn.id));
      await audit(tx, ctx, { action: `payments.event_${out.status}`, entityType: "webhook_event", entityId: row.id, metadata: { eventId: row.eventId, type: row.eventType, detail: out.detail } });
      return out;
    });
    return outcome;
  } catch (e) {
    const message = (e as Error).message;
    if (e instanceof NotOurs) {
      await db.update(webhookEvents).set({ status: "ignored", processedAt: new Date(), error: message }).where(eq(webhookEvents.id, row.id));
      return { status: "ignored", detail: message };
    }
    await db.update(webhookEvents).set({ status: "failed", error: message.slice(0, 1000) }).where(eq(webhookEvents.id, row.id));
    await db.update(integrationConnections).set({ lastError: message.slice(0, 500) }).where(eq(integrationConnections.id, conn.id));
    throw e;
  }
}
