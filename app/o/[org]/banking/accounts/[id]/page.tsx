import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { can } from "@/lib/context";
import { loadMoneyAccount } from "@/lib/banking/common";
import { accountRegister } from "@/lib/banking/overview";
import { listBankTransactions } from "@/lib/banking/transactions";
import { lastCompleted } from "@/lib/banking/reconcile";
import { dateParam, readParams, type SearchParams } from "@/lib/web/params";
import { Badge, Card, DateText, FilterBar, FilterField, LinkButton, Money, PageHeader, StatusBadge, Table, Td, Th, inputClass } from "@/components/ui";

export const metadata = { title: "Bank account" };

export default async function BankAccount({ params, searchParams }: { params: Promise<{ org: string; id: string }>; searchParams: SearchParams }) {
  const { org, id } = await params;
  const sp = await readParams(searchParams);
  const ctx = await orgCtx(org);
  const db = getDb();
  const account = await loadMoneyAccount(db, ctx, id);
  const register = await accountRegister(db, ctx, id, { from: dateParam(sp.from), to: dateParam(sp.to) });
  const bankTxns = await listBankTransactions(db, ctx.orgId, { accountId: id, status: "all", from: dateParam(sp.from), to: dateParam(sp.to), pageSize: 100 });
  const last = await lastCompleted(db, ctx.orgId, id);
  const base = `/o/${org}`;
  const cur = account.currencyResolved;
  return (
    <>
      <PageHeader
        title={account.name}
        description={`${account.code} · ${cur}${last ? ` · reconciled through ${last.statementDate}` : " · never reconciled"}`}
        back={{ href: `${base}/banking`, label: "Bank accounts" }}
        actions={
          <>
            {can(ctx, "banking.import") && (
              <LinkButton variant="secondary" href={`${base}/banking/imports/new?account=${id}`}>
                Import a statement
              </LinkButton>
            )}
            {can(ctx, "banking.reconcile") && (
              <LinkButton variant="secondary" href={`${base}/banking/reconciliations?account=${id}`}>
                Reconcile
              </LinkButton>
            )}
            <LinkButton href={`${base}/banking/transactions?account=${id}`}>Review</LinkButton>
          </>
        }
      />
      <FilterBar>
        <FilterField label="From">
          <input type="date" name="from" defaultValue={sp.from} className={inputClass} />
        </FilterField>
        <FilterField label="To">
          <input type="date" name="to" defaultValue={sp.to} className={inputClass} />
        </FilterField>
      </FilterBar>
      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="In the books (register)" padded={false}>
          {register.length === 0 ? (
            <p className="p-4 text-sm text-slate-500">Nothing posted to this account in the range.</p>
          ) : (
            <Table className="rounded-none border-0 shadow-none">
              <thead>
                <tr>
                  <Th>Date</Th>
                  <Th>Description</Th>
                  <Th align="right">Amount</Th>
                  <Th align="right">Balance</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {register.map((r) => (
                  <tr key={r.line_id}>
                    <Td>
                      <DateText date={r.entry_date} />
                    </Td>
                    <Td>
                      <Link href={`${base}/accounting/journal/${r.entry_id}`} className="hover:text-brand-700">
                        {r.description}
                      </Link>
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        {r.contact_name && <span className="text-xs text-slate-500">{r.contact_name}</span>}
                        {r.matched && <Badge tone="blue">matched</Badge>}
                        {r.cleared_through && <Badge tone="green">cleared {r.cleared_through}</Badge>}
                      </div>
                    </Td>
                    <Td align="right">
                      <Money amount={r.amount} currency={cur} />
                    </Td>
                    <Td align="right">
                      <Money amount={r.running} currency={cur} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        <Card title="From the bank" padded={false}>
          {bankTxns.rows.length === 0 ? (
            <p className="p-4 text-sm text-slate-500">No bank transactions in the range. Import a statement or connect a feed.</p>
          ) : (
            <Table className="rounded-none border-0 shadow-none">
              <thead>
                <tr>
                  <Th>Date</Th>
                  <Th>Description</Th>
                  <Th>Status</Th>
                  <Th align="right">Amount</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {bankTxns.rows.map(({ txn }) => (
                  <tr key={txn.id}>
                    <Td>
                      <DateText date={txn.postedDate} />
                    </Td>
                    <Td>
                      <Link href={`${base}/banking/transactions/${txn.id}`} className="hover:text-brand-700">
                        {txn.description}
                      </Link>
                    </Td>
                    <Td>
                      <StatusBadge status={txn.autoCategorized && !txn.reviewedAt ? "auto-categorized" : txn.status} />
                    </Td>
                    <Td align="right">
                      <Money amount={txn.amount} currency={cur} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
