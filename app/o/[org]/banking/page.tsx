import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { can } from "@/lib/context";
import { moneyAccountSummaries } from "@/lib/banking/overview";
import { SUBTYPE_LABELS } from "@/lib/ledger/accounts";
import { formatDateTime } from "@/lib/money/format";
import { Badge, DateText, EmptyState, LinkButton, Money, PageHeader, Stat, Grid, Table, Td, Th } from "@/components/ui";
import type { AccountSubtype } from "@/lib/db/schema/ledger";

export const metadata = { title: "Bank accounts" };

export default async function BankingOverview({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await orgCtx(org);
  const accounts = await moneyAccountSummaries(getDb(), ctx);
  const base = `/o/${org}`;
  const toReview = accounts.reduce((n, a) => n + a.toReview, 0);
  return (
    <>
      <PageHeader
        title="Bank accounts"
        description="What the bank says, next to what the books say. Import statements or connect a feed; then match, categorize and reconcile."
        actions={
          <>
            {can(ctx, "banking.import") && (
              <LinkButton variant="secondary" href={`${base}/banking/imports/new`}>
                Import a statement
              </LinkButton>
            )}
            {can(ctx, "accounts.manage") && (
              <LinkButton variant="secondary" href={`${base}/accounting/accounts/new`}>
                Add an account
              </LinkButton>
            )}
            <LinkButton href={`${base}/banking/transactions`}>Review transactions{toReview ? ` (${toReview})` : ""}</LinkButton>
          </>
        }
      />
      {accounts.length === 0 ? (
        <EmptyState title="No bank, cash or credit-card accounts" action={can(ctx, "accounts.manage") && <LinkButton href={`${base}/accounting/accounts/new`}>Add a bank account</LinkButton>}>
          Add an account of type Bank, Credit card, Cash or Clearing to the chart of accounts.
        </EmptyState>
      ) : (
        <>
          <div className="mb-6">
            <Grid cols={3}>
              <Stat label="Waiting for review" value={toReview} href={`${base}/banking/transactions`} tone={toReview ? "warning" : "good"} hint="Bank transactions not yet matched, categorized or excluded" />
              <Stat label="Accounts reconciled" value={`${accounts.filter((a) => a.lastReconciled).length} of ${accounts.length}`} href={`${base}/banking/reconciliations`} />
              <Stat label="Connected feeds" value={accounts.filter((a) => a.feed).length} href={`${base}/settings/integrations`} hint="SimpleFIN or the sandbox bank" />
            </Grid>
          </div>
          <Table>
            <thead>
              <tr>
                <Th>Account</Th>
                <Th align="right">Book balance</Th>
                <Th className="hidden md:table-cell">Reconciled through</Th>
                <Th align="right">To review</Th>
                <Th className="hidden lg:table-cell">Feed / last import</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {accounts.map((a) => (
                <tr key={a.id} className={a.isArchived ? "opacity-60" : "hover:bg-slate-50"}>
                  <Td>
                    <Link href={`${base}/banking/accounts/${a.id}`} className="font-medium text-slate-900 hover:text-brand-700">
                      {a.name}
                    </Link>
                    <div className="text-xs text-slate-500">
                      {a.code} · {SUBTYPE_LABELS[a.subtype as AccountSubtype]}
                      {a.institution ? ` · ${a.institution}` : ""}
                      {a.mask ? ` ••${a.mask}` : ""}
                      {a.currency !== ctx.org.baseCurrency && <> · {a.currency}</>}
                    </div>
                  </Td>
                  <Td align="right">
                    <Money amount={a.bookBalance} currency={a.currency} />
                  </Td>
                  <Td className="hidden md:table-cell">
                    {a.lastReconciled ? (
                      <span>
                        <DateText date={a.lastReconciled.statementDate} /> <span className="text-xs text-slate-500">(<Money amount={a.lastReconciled.statementBalance} currency={a.currency} />)</span>
                      </span>
                    ) : (
                      <span className="text-slate-400">Never</span>
                    )}
                    {a.inProgressReconciliationId && (
                      <Link href={`${base}/banking/reconciliations/${a.inProgressReconciliationId}`} className="ml-2">
                        <Badge tone="amber">in progress</Badge>
                      </Link>
                    )}
                  </Td>
                  <Td align="right">
                    {a.toReview ? (
                      <Link href={`${base}/banking/transactions?account=${a.id}`} className="font-medium text-amber-700 hover:underline">
                        {a.toReview}
                      </Link>
                    ) : (
                      <span className="text-slate-400">0</span>
                    )}
                  </Td>
                  <Td className="hidden text-xs text-slate-600 lg:table-cell">
                    {a.feed ? (
                      <div>
                        <Badge tone={a.feed.status === "active" ? "green" : "red"}>{a.feed.provider === "sandbox" ? "sandbox feed" : a.feed.provider}</Badge>{" "}
                        {a.feed.lastSyncedAt ? `synced ${formatDateTime(a.feed.lastSyncedAt, ctx.org.timezone)}` : "not synced yet"}
                        {a.feed.lastError && <div className="text-danger-700">{a.feed.lastError}</div>}
                      </div>
                    ) : null}
                    {a.lastImportAt ? <div>Last import {formatDateTime(a.lastImportAt, ctx.org.timezone)}</div> : !a.feed && <span className="text-slate-400">No imports yet</span>}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      )}
    </>
  );
}
