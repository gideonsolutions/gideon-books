import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { AGING_BUCKETS, customerStatement } from "@/lib/sales/statements";
import { can } from "@/lib/context";
import { dateParam, readParams, type SearchParams } from "@/lib/web/params";
import { startOfMonth, todayIn } from "@/lib/dates";
import { Decimal } from "@/lib/money/decimal";
import { sourceHref } from "@/lib/web/links";
import { Card, DateText, FilterBar, FilterField, Money, PageHeader, Table, Td, Th, buttonClass, inputClass } from "@/components/ui";
import { ActionForm, SubmitButton, TextAreaField, TextField } from "@/components/client/forms";
import { emailStatementAction } from "../../../actions";

export const metadata = { title: "Customer statement" };

export default async function StatementPage({ params, searchParams }: { params: Promise<{ org: string; id: string }>; searchParams: SearchParams }) {
  const { org, id } = await params;
  const sp = await readParams(searchParams);
  const ctx = await orgCtx(org);
  const today = todayIn(ctx.org.timezone);
  const to = dateParam(sp.to) ?? today;
  const from = dateParam(sp.from) ?? startOfMonth(to);
  const s = await customerStatement(getDb(), ctx, id, from, to).catch(() => null);
  if (!s) notFound();
  const base = `/o/${org}`;
  const qs = `from=${from}&to=${to}`;
  return (
    <>
      <PageHeader
        title={`Statement — ${s.contact.displayName}`}
        description={`Everything charged and credited to the customer from ${from} to ${to}, in ${s.currency}. The closing balance is what the receivables ledger shows for them.`}
        back={{ href: `${base}/sales/customers/${id}`, label: s.contact.displayName }}
        actions={
          <a className={buttonClass("secondary")} href={`${base}/sales/customers/${id}/statement/pdf?${qs}`} target="_blank" rel="noopener">
            PDF
          </a>
        }
      />
      <FilterBar>
        <FilterField label="From">
          <input type="date" name="from" defaultValue={from} className={inputClass} />
        </FilterField>
        <FilterField label="To">
          <input type="date" name="to" defaultValue={to} className={inputClass} />
        </FilterField>
      </FilterBar>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          <Table>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Reference</Th>
                <Th>Description</Th>
                <Th align="right">Charges</Th>
                <Th align="right">Credits</Th>
                <Th align="right">Balance</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              <tr className="bg-slate-50 text-slate-600">
                <Td><DateText date={from} /></Td>
                <Td />
                <Td>Opening balance</Td>
                <Td />
                <Td />
                <Td align="right"><Money amount={s.opening} currency={s.currency} /></Td>
              </tr>
              {s.lines.map((l) => {
                const href = sourceHref(base, l.sourceType, l.sourceId) ?? `${base}/accounting/journal/${l.entryId}`;
                return (
                  <tr key={l.entryId}>
                    <Td><DateText date={l.date} /></Td>
                    <Td><Link className="text-brand-700 hover:underline" href={href}>{l.reference ?? l.kind.replace(/_/g, " ")}</Link></Td>
                    <Td className="max-w-xs truncate">{l.description}</Td>
                    <Td align="right">{!Decimal.from(l.charge).isZero() && <Money amount={l.charge} currency={s.currency} />}</Td>
                    <Td align="right">{!Decimal.from(l.credit).isZero() && <Money amount={l.credit} currency={s.currency} />}</Td>
                    <Td align="right"><Money amount={l.balance} currency={s.currency} /></Td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="bg-slate-50 font-semibold">
              <tr>
                <Td colSpan={3}>Closing balance on <DateText date={to} /></Td>
                <Td align="right"><Money amount={s.totalCharges} currency={s.currency} /></Td>
                <Td align="right"><Money amount={s.totalCredits} currency={s.currency} /></Td>
                <Td align="right"><Money amount={s.closing} currency={s.currency} /></Td>
              </tr>
            </tfoot>
          </Table>
          <Card title={`Open by age on ${to}`}>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              {AGING_BUCKETS.map((b, i) => (
                <div key={b}>
                  <dt className="text-xs uppercase tracking-wide text-slate-500">{b}</dt>
                  <dd className="num mt-1 font-semibold"><Money amount={s.aging[i]!} currency={s.currency} /></dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 text-xs text-slate-500">Unapplied payments, deposits and credit notes count as current (negative).</p>
          </Card>
        </div>
        {can(ctx, "sales.manage") && (
          <Card title="Email the statement">
            <ActionForm action={emailStatementAction.bind(null, org, id)} className="space-y-3">
              <input type="hidden" name="from" value={from} />
              <input type="hidden" name="to" value={to} />
              <TextField label="To" name="email" type="email" required defaultValue={s.contact.email ?? ""} />
              <TextField label="Copy to" name="cc" type="email" />
              <TextAreaField label="Message (optional)" name="body" rows={4} />
              <SubmitButton pendingText="Queuing…">Email with PDF</SubmitButton>
            </ActionForm>
          </Card>
        )}
      </div>
    </>
  );
}
