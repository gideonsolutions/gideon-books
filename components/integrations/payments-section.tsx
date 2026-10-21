/**
 * Integration settings for card payments: connect Stripe (with the
 * organization's own keys) or the local sandbox, choose the clearing, payout
 * and fee accounts, see the webhook endpoint and recent events.
 */
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { webhookEvents } from "@/lib/db/schema/core";
import { can, type Ctx } from "@/lib/context";
import { describeConnection, listPaymentConnections } from "@/lib/integrations/payments/connections";
import { accountOptions } from "@/lib/web/options";
import { formatDateTime } from "@/lib/money/format";
import { Alert, Badge, Card } from "@/components/ui";
import { ActionForm, ConfirmButton, SelectField, SubmitButton, TextField } from "@/components/client/forms";
import { connectSandboxAction, connectStripeAction, disconnectAction, simulatePayoutAction, updateConnectionAction } from "@/app/o/[org]/sales/actions";

export async function PaymentsSection({ ctx }: { ctx: Ctx }) {
  const db = getDb();
  const slug = ctx.org.slug;
  const conns = await listPaymentConnections(db, ctx.orgId);
  const active = conns.find((c) => c.status === "active");
  const manage = can(ctx, "integrations.manage");
  const clearing = await accountOptions(db, ctx.orgId, { subtypes: ["clearing", "bank"] });
  const banks = await accountOptions(db, ctx.orgId, { subtypes: ["bank"] });
  const fees = await accountOptions(db, ctx.orgId, { types: ["expense"] });
  const events = active
    ? await db.select().from(webhookEvents).where(and(eq(webhookEvents.orgId, ctx.orgId), eq(webhookEvents.connectionId, active.id))).orderBy(desc(webhookEvents.receivedAt)).limit(10)
    : [];
  const d = active ? describeConnection(active) : null;
  return (
    <Card title="Card payments">
      <p className="mb-4 text-sm text-slate-600">
        Let customers pay invoices by card through a payment link. A payment is recorded gross into a clearing account, the processor&apos;s fee is expensed, and the
        provider&apos;s payout moves the rest to the bank — so the clearing account reconciles to the provider. Gideon Books never initiates a transfer; customers pay
        through the provider&apos;s own checkout.
      </p>
      {d ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{d.displayName}</span>
            <Badge tone={d.mode === "sandbox" ? "amber" : "green"}>{d.mode === "sandbox" ? "sandbox — no real money" : d.testMode ? "Stripe test mode" : "live"}</Badge>
            {d.lastSyncedAt && <span className="text-xs text-slate-500">last event {formatDateTime(d.lastSyncedAt, ctx.org.timezone)}</span>}
          </div>
          {d.lastError && <Alert tone="danger" title="The last event failed">{d.lastError}</Alert>}
          {d.provider === "stripe" && (
            <div className="rounded-md bg-slate-50 p-3 text-sm">
              <div>
                API key <code>{d.apiKeyMasked}</code> · signing secret <code>{d.webhookSecretMasked}</code>
              </div>
              <div className="mt-1">
                In Stripe (Developers → Webhooks), send <code>checkout.session.completed</code>, <code>payment_intent.succeeded</code>, <code>charge.refunded</code> and{" "}
                <code>payout.paid</code> to:
              </div>
              <code className="mt-1 block break-all">{d.webhookUrl}</code>
            </div>
          )}
          {manage && (
            <ActionForm action={updateConnectionAction.bind(null, slug, d.id)} className="grid gap-3 sm:grid-cols-3">
              <SelectField label="Clearing account" name="clearingAccountId" options={clearing} defaultValue={d.clearingAccountId ?? ""} />
              <SelectField label="Payouts arrive in" name="bankAccountId" placeholder="Choose…" options={banks} defaultValue={d.bankAccountId ?? ""} hint="Needed to record payouts." />
              <SelectField label="Fees account" name="feeAccountId" options={fees} defaultValue={d.feeAccountId ?? ""} />
              <div className="sm:col-span-3 flex justify-end gap-2">
                <SubmitButton variant="secondary">Save accounts</SubmitButton>
              </div>
            </ActionForm>
          )}
          {d.provider === "sandbox" && can(ctx, "payments.record") && (
            <ActionForm action={simulatePayoutAction.bind(null, slug)} className="flex flex-wrap items-end gap-3 rounded-md border border-amber-200 bg-amber-50 p-3">
              <TextField label={`Simulate a payout (${ctx.org.baseCurrency})`} name="amount" inputMode="decimal" required />
              <SubmitButton variant="secondary">Simulate payout</SubmitButton>
            </ActionForm>
          )}
          {events.length > 0 && (
            <div>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Recent events</h4>
              <ul className="divide-y divide-slate-100 text-sm">
                {events.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                    <span>
                      {e.eventType} <span className="text-xs text-slate-500">{formatDateTime(e.receivedAt, ctx.org.timezone)}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      {e.error && <span className="max-w-xs truncate text-xs text-slate-500" title={e.error}>{e.error}</span>}
                      <Badge tone={e.status === "processed" ? "green" : e.status === "failed" ? "red" : e.status === "ignored" ? "gray" : "amber"}>{e.status}</Badge>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {manage && (
            <ConfirmButton
              action={disconnectAction.bind(null, slug, d.id)}
              label="Disconnect"
              variant="danger"
              title="Disconnect card payments?"
              body="Open payment links stop working and new events are refused. Payments already recorded stay in the books."
              confirmLabel="Disconnect"
            />
          )}
        </div>
      ) : manage ? (
        <div className="grid gap-6 lg:grid-cols-2">
          {!ctx.org.isDemo ? (
            <div className="rounded-md border border-slate-200 p-4">
              <h4 className="font-medium">Stripe</h4>
              <p className="mb-3 text-xs text-slate-600">Use your own Stripe account. Create a restricted or secret key and a webhook endpoint; keys are encrypted at rest and never shown again.</p>
              <ActionForm action={connectStripeAction.bind(null, slug)} className="space-y-3">
                <TextField label="Secret key" name="apiKey" required autoComplete="off" placeholder="sk_live_… or sk_test_…" />
                <TextField label="Webhook signing secret" name="webhookSecret" required autoComplete="off" placeholder="whsec_…" />
                <SelectField label="Payouts arrive in" name="bankAccountId" placeholder="Choose…" options={banks} />
                <SubmitButton>Connect Stripe</SubmitButton>
              </ActionForm>
            </div>
          ) : (
            <Alert tone="warning">Demonstration companies can only use the sandbox.</Alert>
          )}
          <div className="rounded-md border border-amber-200 bg-amber-50/50 p-4">
            <h4 className="font-medium">Sandbox</h4>
            <p className="mb-3 text-xs text-slate-600">A local stand-in for trying the whole flow — checkout page, signed webhooks, fees, refunds and payouts — without a provider account. No money ever moves.</p>
            <ActionForm action={connectSandboxAction.bind(null, slug)} className="space-y-3">
              <TextField label="Simulated fee (%)" name="feePercent" defaultValue="2.9" inputMode="decimal" hint="Plus 0.30 per payment." />
              <SelectField label="Payouts arrive in" name="bankAccountId" placeholder="Choose…" options={banks} />
              <SubmitButton variant="secondary">Connect the sandbox</SubmitButton>
            </ActionForm>
          </div>
        </div>
      ) : (
        <p className="text-sm text-slate-600">Not connected. An administrator can connect a provider.</p>
      )}
    </Card>
  );
}
