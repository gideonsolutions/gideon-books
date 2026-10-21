import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { can } from "@/lib/context";
import { hostedMode, usageThisMonth } from "@/lib/hosted/metering";
import { limitFor, planByKey, subscriptionFor } from "@/lib/hosted/plans";
import { billingConfig } from "@/lib/hosted/billing";
import { USAGE_METRICS, type UsageMetric } from "@/lib/db/schema/hosted";
import { readParams, type SearchParams } from "@/lib/web/params";
import { Alert, Badge, Card, PageHeader } from "@/components/ui";
import { ActionButton } from "@/components/client/forms";
import { formatDateTime } from "@/lib/money/format";
import { manageBillingAction, subscribeAction } from "./actions";

export const metadata = { title: "Plan and usage" };

const METRIC: Record<UsageMetric, { label: string; unit: (n: number) => string; note: string }> = {
  bank_feed_syncs: { label: "Bank-feed syncs", unit: (n) => n.toLocaleString("en-US"), note: "Each automatic or manual sync of a connected bank account." },
  documents_processed: { label: "Documents processed", unit: (n) => n.toLocaleString("en-US"), note: "Each file uploaded or generated (receipts, statements, PDFs)." },
  storage_bytes: { label: "File storage", unit: (n) => `${(n / 1024 ** 3).toFixed(2)} GB`, note: "Total size of stored attachments (not monthly)." },
  emails_sent: { label: "Emails delivered", unit: (n) => n.toLocaleString("en-US"), note: "Invoices, statements and notices actually sent." },
};

export default async function Billing({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  const { org } = await params;
  const sp = await readParams(searchParams);
  const ctx = await orgCtx(org);
  if (!hostedMode()) {
    return (
      <>
        <PageHeader title="Plan and usage" />
        <Card>
          <p className="text-sm text-slate-700">
            This server is <strong>self-hosted</strong>. There is no plan, no subscription and no usage limit: every feature works without a hosted service. Provider costs (bank feeds, email delivery, storage) are between the server&apos;s operator and those providers.
          </p>
        </Card>
      </>
    );
  }
  const db = getDb();
  const sub = await subscriptionFor(db, ctx.orgId);
  const plan = planByKey(sub?.planKey);
  const cfg = billingConfig();
  const usage = await Promise.all(USAGE_METRICS.map(async (m) => ({ m, used: await usageThisMonth(db, ctx.orgId, m), limit: await limitFor(db, ctx.orgId, m) })));
  const status = sub?.status ?? "trialing";
  return (
    <>
      <PageHeader title="Plan and usage" description="Your books, your reports and the complete data export are always available, whatever the state of the subscription. Limits apply only to services that cost money to run." />
      {sp.checkout === "success" && (
        <div className="mb-4">
          <Alert tone="success">Thank you. The subscription becomes active as soon as Stripe confirms the payment (usually within a minute).</Alert>
        </div>
      )}
      {status === "canceled" && (
        <div className="mb-4">
          <Alert tone="warning" title="The subscription has ended">
            Bank feeds, email delivery and new uploads are paused. Everything already in the books, every report and the full export remain available.
          </Alert>
        </div>
      )}
      {status === "past_due" && (
        <div className="mb-4">
          <Alert tone="warning">The last payment failed. Services continue for now; update the payment method to keep them running.</Alert>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Card title="Usage this month">
          <ul className="space-y-4">
            {usage.map(({ m, used, limit }) => {
              const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
              return (
                <li key={m}>
                  <div className="flex justify-between text-sm">
                    <span className="font-medium text-slate-800">{METRIC[m].label}</span>
                    <span className="num text-slate-600">
                      {METRIC[m].unit(used)} of {limit === null ? "unlimited" : METRIC[m].unit(limit)}
                    </span>
                  </div>
                  {limit !== null && (
                    <div className="mt-1 h-2 rounded-full bg-slate-100" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={METRIC[m].label}>
                      <div className={`h-2 rounded-full ${pct >= 100 ? "bg-danger-600" : pct >= 80 ? "bg-amber-500" : "bg-brand-600"}`} style={{ width: `${pct}%` }} />
                    </div>
                  )}
                  <p className="mt-1 text-xs text-slate-500">{METRIC[m].note}</p>
                </li>
              );
            })}
          </ul>
        </Card>
        <Card title="Plan">
          <div className="text-lg font-semibold text-slate-900">{plan.name}</div>
          <div className="mt-1 text-sm text-slate-700">
            ${(plan.monthlyPriceCents / 100).toFixed(2)} a month <Badge tone="amber">tentative</Badge>
          </div>
          <p className="mt-1 text-xs text-slate-500">The price is not final; nothing is charged without your confirming it at checkout.</p>
          <div className="mt-3 text-sm">
            Status: <Badge tone={status === "active" ? "green" : status === "canceled" ? "red" : "amber"}>{status.replace("_", " ")}</Badge>
            {sub?.currentPeriodEnd && <div className="mt-1 text-xs text-slate-500">Current period ends {formatDateTime(sub.currentPeriodEnd)}</div>}
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {!cfg.configured ? (
              <p className="text-sm text-amber-800">Billing is not set up on this server yet (missing {cfg.missing.join(", ")}). Nothing can be bought here until it is.</p>
            ) : !can(ctx, "billing.manage") ? (
              <p className="text-sm text-slate-600">Only the owner manages billing.</p>
            ) : ctx.org.isDemo ? (
              <p className="text-sm text-slate-600">Demonstration companies cannot be subscribed.</p>
            ) : sub?.providerCustomerId ? (
              <ActionButton action={manageBillingAction.bind(null, org)}>Manage billing</ActionButton>
            ) : (
              <ActionButton action={subscribeAction.bind(null, org)} variant="primary">
                Subscribe
              </ActionButton>
            )}
          </div>
        </Card>
      </div>
    </>
  );
}
