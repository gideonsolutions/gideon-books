import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { listAccounts } from "@/lib/ledger/accounts";
import { openingBalanceEntries } from "@/lib/ledger/opening-balances";
import { contactOptions, currencyOptions } from "@/lib/web/options";
import { documents } from "@/lib/db/schema/commerce";
import { can } from "@/lib/context";
import { addDays } from "@/lib/dates";
import { Alert, Card, DateText, Money, PageHeader, Table, Td, Th, inputClass } from "@/components/ui";
import { ActionForm, SelectField, SubmitButton, TextField } from "@/components/client/forms";
import { openingBalancesAction, openingDocumentAction } from "../actions";

export const metadata = { title: "Opening balances" };

export default async function OpeningBalances({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await orgCtx(org);
  const db = getDb();
  const accounts = (await listAccounts(db, ctx.orgId)).filter((a) => !a.control && a.systemKey !== "opening_balance_equity" && a.type !== "income" && a.type !== "expense" && a.subtype !== "retained_earnings");
  const entries = await openingBalanceEntries(ctx.orgId);
  const openingDocs = await db.select().from(documents).where(and(eq(documents.orgId, ctx.orgId), eq(documents.isOpeningBalance, true)));
  const asOf = ctx.org.booksStartDate ? addDays(ctx.org.booksStartDate, -1) : "";
  const editable = can(ctx, "opening_balances.manage");
  const base = `/o/${org}`;
  const customers = await contactOptions(db, ctx.orgId, "customer");
  const vendors = await contactOptions(db, ctx.orgId, "vendor");
  const currencies = [{ value: "", label: `${ctx.org.baseCurrency} (base)` }, ...currencyOptions().filter((c) => c.value !== ctx.org.baseCurrency)];
  return (
    <>
      <PageHeader
        title="Opening balances"
        description="What the books held the day before they start in Gideon Books. Enter balances from your last balance sheet; anything that doesn't balance goes to Opening Balance Equity, which should reach zero once everything is in."
      />
      {entries.length > 0 && (
        <div className="mb-6">
          <Alert tone="info" title="Opening balances already posted">
            {entries.map((e) => (
              <span key={e.id} className="mr-3">
                <Link className="underline" href={`${base}/accounting/journal/${e.id}`}>
                  Entry #{e.entryNumber}
                </Link>{" "}
                (<DateText date={e.entryDate} />)
              </span>
            ))}
            . Posting again adds to them; reverse an entry to correct it.
          </Alert>
        </div>
      )}
      <div className="space-y-6">
        <Card title="1. Account balances">
          {editable ? (
            <ActionForm action={openingBalancesAction.bind(null, org)} className="space-y-4">
              <div className="max-w-xs">
                <TextField label="Balances as of" name="asOf" type="date" defaultValue={asOf} required hint="Usually the last day before the books start." />
              </div>
              <Table>
                <thead>
                  <tr>
                    <Th>Account</Th>
                    <Th align="right">Debit</Th>
                    <Th align="right">Credit</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {accounts.map((a) => (
                    <tr key={a.id}>
                      <Td>
                        <span className="font-mono text-xs text-slate-500">{a.code}</span> {a.name}
                        {a.currency && <span className="ml-1 text-xs text-slate-500">(in {a.currency})</span>}
                      </Td>
                      <Td align="right">
                        <input name={`bal.${a.id}.debit`} className={`${inputClass} num w-36 text-right`} inputMode="decimal" aria-label={`${a.name} debit`} />
                      </Td>
                      <Td align="right">
                        <input name={`bal.${a.id}.credit`} className={`${inputClass} num w-36 text-right`} inputMode="decimal" aria-label={`${a.name} credit`} />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <div className="flex justify-end">
                <SubmitButton pendingText="Posting…">Post opening balances</SubmitButton>
              </div>
            </ActionForm>
          ) : (
            <p className="text-sm text-slate-600">Your role cannot enter opening balances.</p>
          )}
        </Card>
        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="2. Open customer invoices">
            <p className="mb-3 text-sm text-slate-600">Each unpaid invoice from before, so payments can be applied to it. Posts to receivables against Opening Balance Equity.</p>
            {editable && (
              <ActionForm action={openingDocumentAction.bind(null, org, "invoice")} resetOnSuccess className="grid gap-3 sm:grid-cols-2">
                <SelectField label="Customer" name="contactId" options={customers} placeholder="Choose…" required />
                <TextField label="Invoice number" name="reference" />
                <TextField label="Invoice date" name="issueDate" type="date" defaultValue={asOf} required />
                <TextField label="Due date" name="dueDate" type="date" />
                <TextField label="Amount still open" name="amount" inputMode="decimal" required />
                <SelectField label="Currency" name="currency" options={currencies} />
                <TextField label="Rate (if foreign)" name="fxRate" inputMode="decimal" />
                <div className="flex items-end justify-end">
                  <SubmitButton variant="secondary">Add invoice</SubmitButton>
                </div>
              </ActionForm>
            )}
          </Card>
          <Card title="3. Unpaid vendor bills">
            <p className="mb-3 text-sm text-slate-600">Each bill you still owe. Posts to payables against Opening Balance Equity.</p>
            {editable && (
              <ActionForm action={openingDocumentAction.bind(null, org, "bill")} resetOnSuccess className="grid gap-3 sm:grid-cols-2">
                <SelectField label="Vendor" name="contactId" options={vendors} placeholder="Choose…" required />
                <TextField label="Vendor's bill number" name="reference" />
                <TextField label="Bill date" name="issueDate" type="date" defaultValue={asOf} required />
                <TextField label="Due date" name="dueDate" type="date" />
                <TextField label="Amount still owed" name="amount" inputMode="decimal" required />
                <SelectField label="Currency" name="currency" options={currencies} />
                <TextField label="Rate (if foreign)" name="fxRate" inputMode="decimal" />
                <div className="flex items-end justify-end">
                  <SubmitButton variant="secondary">Add bill</SubmitButton>
                </div>
              </ActionForm>
            )}
          </Card>
        </div>
        {openingDocs.length > 0 && (
          <Card title="Opening invoices and bills entered" padded={false}>
            <Table className="rounded-none border-0 shadow-none">
              <thead>
                <tr>
                  <Th>Kind</Th>
                  <Th>Number</Th>
                  <Th>Date</Th>
                  <Th align="right">Amount</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {openingDocs.map((d) => (
                  <tr key={d.id}>
                    <Td>{d.kind}</Td>
                    <Td>
                      <Link className="text-brand-700 hover:underline" href={`${base}/documents/${d.id}`}>
                        {d.number ?? d.reference}
                      </Link>
                    </Td>
                    <Td>
                      <DateText date={d.issueDate} />
                    </Td>
                    <Td align="right">
                      <Money amount={d.total} currency={d.currency} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        )}
        <Card title="4. Stock and fixed assets">
          <p className="text-sm text-slate-600">
            Opening stock is entered per item and location under{" "}
            <Link className="text-brand-700 hover:underline" href={`${base}/inventory/movements`}>
              Adjustments & transfers
            </Link>
            ; fixed assets with their accumulated depreciation under{" "}
            <Link className="text-brand-700 hover:underline" href={`${base}/assets`}>
              Asset register
            </Link>
            . Both post against Opening Balance Equity, so their subledgers agree with the ledger from day one.
          </p>
        </Card>
      </div>
    </>
  );
}
