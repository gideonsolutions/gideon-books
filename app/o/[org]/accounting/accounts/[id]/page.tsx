import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { getAccount, SUBTYPE_LABELS } from "@/lib/ledger/accounts";
import { accountOptions, currencyOptions, subtypeOptions } from "@/lib/web/options";
import { accountBalances } from "@/lib/ledger/balances";
import { bankAccountDetails, journalEntries, journalLines } from "@/lib/db/schema/ledger";
import { can } from "@/lib/context";
import { Badge, Card, DateText, DescriptionList, LinkButton, Money, PageHeader, Table, Td, Th } from "@/components/ui";
import { ActionButton } from "@/components/client/forms";
import { AccountForm } from "@/components/accounting/account-form";
import { archiveAccountAction, updateAccountAction } from "../../actions";

export const metadata = { title: "Account" };

export default async function AccountPage({ params }: { params: Promise<{ org: string; id: string }> }) {
  const { org, id } = await params;
  const ctx = await orgCtx(org);
  const db = getDb();
  const account = await getAccount(db, ctx.orgId, id);
  const [bank] = await db.select().from(bankAccountDetails).where(eq(bankAccountDetails.accountId, id));
  const bal = (await accountBalances(db, ctx.orgId)).get(id);
  const recent = await db
    .select({ line: journalLines, entry: journalEntries })
    .from(journalLines)
    .innerJoin(journalEntries, and(eq(journalEntries.id, journalLines.entryId), eq(journalEntries.orgId, journalLines.orgId)))
    .where(and(eq(journalLines.orgId, ctx.orgId), eq(journalLines.accountId, id), eq(journalEntries.status, "posted")))
    .orderBy(desc(journalEntries.entryDate), desc(journalEntries.entryNumber))
    .limit(15);
  const base = `/o/${org}`;
  const parents = (await accountOptions(db, ctx.orgId, { types: [account.type] })).filter((o) => o.value !== id);
  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-lg text-slate-500">{account.code}</span> {account.name}
            {account.isArchived && <Badge tone="amber">archived</Badge>}
            {account.control && <Badge>subledger: {account.control.replace(/_/g, " ")}</Badge>}
          </span>
        }
        back={{ href: `${base}/accounting/accounts`, label: "Chart of accounts" }}
        actions={
          <>
            <LinkButton variant="secondary" href={`${base}/reports/general-ledger?account=${id}`}>
              General ledger
            </LinkButton>
            {can(ctx, "accounts.manage") && !account.systemKey && (
              <ActionButton action={archiveAccountAction.bind(null, org, id, !account.isArchived)}>{account.isArchived ? "Restore" : "Archive"}</ActionButton>
            )}
          </>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          {can(ctx, "accounts.manage") ? (
            <Card title="Details">
              <AccountForm
                action={updateAccountAction.bind(null, org, id)}
                subtypes={subtypeOptions()}
                parents={parents}
                currencies={[{ value: "", label: `${ctx.org.baseCurrency} (base)` }, ...currencyOptions().filter((c) => c.value !== ctx.org.baseCurrency)]}
                defaults={{ ...account, institution: bank?.institution ?? null, mask: bank?.mask ?? null }}
                locked={{ type: (bal?.lines ?? 0) > 0, currency: (bal?.lines ?? 0) > 0 }}
                submitLabel="Save changes"
              />
            </Card>
          ) : (
            <Card title="Details">
              <DescriptionList
                items={[
                  { label: "Type", value: SUBTYPE_LABELS[account.subtype] },
                  { label: "Currency", value: account.currency ?? ctx.org.baseCurrency },
                  { label: "Description", value: account.description },
                ]}
              />
            </Card>
          )}
          <Card title="Recent postings" padded={false}>
            {recent.length === 0 ? (
              <p className="p-4 text-sm text-slate-500">Nothing has been posted to this account yet.</p>
            ) : (
              <Table className="rounded-none border-0 shadow-none">
                <thead>
                  <tr>
                    <Th>Date</Th>
                    <Th>Entry</Th>
                    <Th>Description</Th>
                    <Th align="right">Amount</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {recent.map(({ line, entry }) => (
                    <tr key={line.id}>
                      <Td>
                        <DateText date={entry.entryDate} />
                      </Td>
                      <Td>
                        <Link className="text-brand-700 hover:underline" href={`${base}/accounting/journal/${entry.id}`}>
                          #{entry.entryNumber}
                        </Link>
                      </Td>
                      <Td className="max-w-xs truncate">{line.description || entry.description}</Td>
                      <Td align="right">
                        <Money amount={line.baseAmount} currency={ctx.org.baseCurrency} />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>
        <Card title="Balance">
          <div className="num text-2xl font-semibold">
            <Money amount={bal?.base ?? "0"} currency={ctx.org.baseCurrency} />
          </div>
          {account.currency && (
            <div className="mt-1 text-sm text-slate-600">
              <Money amount={bal?.txn ?? "0"} currency={account.currency} /> in {account.currency}
            </div>
          )}
          <p className="mt-2 text-xs text-slate-500">Debits are positive, credits negative. {bal?.lines ?? 0} postings.</p>
        </Card>
      </div>
    </>
  );
}
