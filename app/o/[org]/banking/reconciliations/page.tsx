import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { can } from "@/lib/context";
import { listReconciliations } from "@/lib/banking/reconcile";
import { moneyAccountSummaries } from "@/lib/banking/overview";
import { readParams, type SearchParams } from "@/lib/web/params";
import { todayIn, addDays, startOfMonth } from "@/lib/dates";
import { Badge, Card, DateText, EmptyState, Money, PageHeader, Table, Td, Th } from "@/components/ui";
import { ActionForm, SelectField, SubmitButton, TextField } from "@/components/client/forms";
import { startReconciliationAction } from "../actions";

export const metadata = { title: "Reconciliations" };

export default async function Reconciliations({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  const { org } = await params;
  const sp = await readParams(searchParams);
  const ctx = await orgCtx(org);
  const db = getDb();
  const accounts = await moneyAccountSummaries(db, ctx);
  const recs = await listReconciliations(db, ctx.orgId, { accountId: sp.account || undefined });
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const base = `/o/${org}`;
  const lastMonthEnd = addDays(startOfMonth(todayIn(ctx.org.timezone)), -1);
  return (
    <>
      <PageHeader title="Reconciliations" description="Agree each bank and card account with its statement. Each reconciliation starts where the last one ended." />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div>
          {recs.length === 0 ? (
            <EmptyState title="No reconciliations yet">Start one with the closing date and ending balance from a statement.</EmptyState>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Account</Th>
                  <Th>Statement date</Th>
                  <Th align="right">Ending balance</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {recs.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-50">
                    <Td>
                      <Link href={`${base}/banking/reconciliations/${r.id}`} className="font-medium text-brand-700 hover:underline">
                        {byId.get(r.accountId)?.name ?? "Account"}
                      </Link>
                    </Td>
                    <Td>
                      <DateText date={r.statementDate} />
                    </Td>
                    <Td align="right">
                      <Money amount={r.statementBalance} currency={byId.get(r.accountId)?.currency ?? ctx.org.baseCurrency} />
                    </Td>
                    <Td>
                      <Badge tone={r.status === "completed" ? "green" : r.status === "in_progress" ? "amber" : "red"}>{r.status.replace("_", " ")}</Badge>
                      {r.adjustmentEntryId && <Badge tone="amber">adjusted</Badge>}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
        {can(ctx, "banking.reconcile") && accounts.length > 0 && (
          <Card title="Reconcile a statement">
            <ActionForm action={startReconciliationAction.bind(null, org)} className="space-y-3">
              <SelectField
                label="Account"
                name="accountId"
                required
                defaultValue={sp.account ?? ""}
                placeholder="Choose…"
                options={accounts.map((a) => ({ value: a.id, label: `${a.name}${a.lastReconciled ? ` (to ${a.lastReconciled.statementDate})` : ""}` }))}
              />
              <TextField label="Statement closing date" name="statementDate" type="date" required defaultValue={lastMonthEnd} />
              <TextField label="Statement ending balance" name="statementBalance" inputMode="decimal" required hint="For a credit card, a balance owed is negative." />
              <SubmitButton>Start</SubmitButton>
            </ActionForm>
          </Card>
        )}
      </div>
    </>
  );
}
