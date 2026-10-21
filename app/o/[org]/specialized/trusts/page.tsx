import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { can, requirePermission } from "@/lib/context";
import { dateParam, readParams, type SearchParams } from "@/lib/web/params";
import { beneficiaryDistributions, principalIncomeStatement, undistributedIncome } from "@/lib/specialized/trusts";
import { contactOptions, moneyAccountOptions } from "@/lib/web/options";
import { todayIn } from "@/lib/dates";
import { Alert, Card, DateText, FilterBar, FilterField, Money, PageHeader, Table, Td, Th, inputClass } from "@/components/ui";
import { ActionForm, SelectField, SubmitButton, TextField } from "@/components/client/forms";
import { distributionAction } from "../actions";

export const metadata = { title: "Trust and estate accounting" };

export default async function Trusts({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  const { org } = await params;
  const sp = await readParams(searchParams);
  const ctx = await orgCtx(org);
  requirePermission(ctx, "reports.read");
  const db = getDb();
  const to = dateParam(sp.to) ?? todayIn(ctx.org.timezone);
  const from = dateParam(sp.from) ?? `${to.slice(0, 4)}-01-01`;
  const cur = ctx.org.baseCurrency;
  const st = await principalIncomeStatement(db, ctx.orgId, from, to);
  const dist = await beneficiaryDistributions(db, ctx.orgId, from, to);
  const und = await undistributedIncome(db, ctx.orgId, from, to);
  const beneficiaries = await contactOptions(db, ctx.orgId, "beneficiary");
  const hasUnassigned = st.totals.unassigned.receipts !== "0" || st.totals.unassigned.disbursements !== "0";
  const row = (label: string, v: { principal: string; income: string; unassigned: string }) => (
    <tr>
      <Td>{label}</Td>
      <Td align="right">
        <Money amount={v.principal} currency={cur} />
      </Td>
      <Td align="right">
        <Money amount={v.income} currency={cur} />
      </Td>
      {hasUnassigned && (
        <Td align="right">
          <Money amount={v.unassigned} currency={cur} />
        </Td>
      )}
    </tr>
  );
  return (
    <>
      <PageHeader
        title="Principal and income"
        description="Receipts, disbursements and distributions as the fiduciary recorded them, principal and income side by side. Gideon Books does not decide what is principal or income under any state's principal-and-income act, does not compute distributable net income, and does not prepare Form 1041."
      />
      <FilterBar>
        <FilterField label="From">
          <input type="date" name="from" defaultValue={from} className={inputClass} />
        </FilterField>
        <FilterField label="To">
          <input type="date" name="to" defaultValue={to} className={inputClass} />
        </FilterField>
      </FilterBar>
      {hasUnassigned && (
        <div className="mb-4">
          <Alert tone="warning">Some receipts or disbursements are not marked principal or income. Mark the lines (trust component) so they are allocated as the fiduciary intends.</Alert>
        </div>
      )}
      <div className="space-y-6">
        <Card title={`Statement, ${from} to ${to}`} padded={false}>
          <Table className="rounded-none border-0 shadow-none">
            <thead>
              <tr>
                <Th>Account</Th>
                <Th align="right">Principal</Th>
                <Th align="right">Income</Th>
                {hasUnassigned && <Th align="right">Not marked</Th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              <tr>
                <Td className="font-semibold" colSpan={4}>
                  Receipts
                </Td>
              </tr>
              {st.receipts.map((r) => (
                <tr key={r.accountId}>
                  <Td>
                    <Link href={`/o/${org}/reports/general-ledger?account=${r.accountId}&from=${from}&to=${to}`} className="hover:underline">
                      {r.code} {r.name}
                    </Link>
                  </Td>
                  <Td align="right">
                    <Money amount={r.amounts.principal} currency={cur} />
                  </Td>
                  <Td align="right">
                    <Money amount={r.amounts.income} currency={cur} />
                  </Td>
                  {hasUnassigned && (
                    <Td align="right">
                      <Money amount={r.amounts.unassigned} currency={cur} />
                    </Td>
                  )}
                </tr>
              ))}
              <tr>
                <Td className="font-semibold" colSpan={4}>
                  Disbursements
                </Td>
              </tr>
              {st.disbursements.map((r) => (
                <tr key={r.accountId}>
                  <Td>
                    <Link href={`/o/${org}/reports/general-ledger?account=${r.accountId}&from=${from}&to=${to}`} className="hover:underline">
                      {r.code} {r.name}
                    </Link>
                  </Td>
                  <Td align="right">
                    <Money amount={r.amounts.principal} currency={cur} />
                  </Td>
                  <Td align="right">
                    <Money amount={r.amounts.income} currency={cur} />
                  </Td>
                  {hasUnassigned && (
                    <Td align="right">
                      <Money amount={r.amounts.unassigned} currency={cur} />
                    </Td>
                  )}
                </tr>
              ))}
              {row("Distributions to beneficiaries", st.distributions)}
            </tbody>
            <tfoot className="bg-slate-50 font-semibold">
              {row("Net change", { principal: st.totals.principal.net, income: st.totals.income.net, unassigned: st.totals.unassigned.net })}
            </tfoot>
          </Table>
        </Card>
        <Card title="Undistributed income">
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-slate-500">This period (income receipts − income disbursements − income distributions)</dt>
              <dd className="num font-semibold">
                <Money amount={und.period.net} currency={cur} />
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">To {to}, since the books began</dt>
              <dd className="num font-semibold">
                <Money amount={und.toDate.net} currency={cur} />
              </dd>
            </div>
          </dl>
        </Card>
        <Card title="Distributions by beneficiary" padded={false}>
          {dist.length === 0 ? (
            <p className="p-4 text-sm text-slate-500">No distributions in this period.</p>
          ) : (
            <Table className="rounded-none border-0 shadow-none">
              <thead>
                <tr>
                  <Th>Beneficiary</Th>
                  <Th align="right">From principal</Th>
                  <Th align="right">From income</Th>
                  <Th align="right">Total</Th>
                  <Th>Entries</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {dist.map((b) => (
                  <tr key={b.beneficiaryId ?? "none"}>
                    <Td className="font-medium">{b.beneficiaryName}</Td>
                    <Td align="right">
                      <Money amount={b.principal} currency={cur} />
                    </Td>
                    <Td align="right">
                      <Money amount={b.income} currency={cur} />
                    </Td>
                    <Td align="right">
                      <Money amount={b.total} currency={cur} />
                    </Td>
                    <Td>
                      <ul className="text-xs">
                        {b.entries.map((e) => (
                          <li key={e.entryId + e.amount}>
                            <Link className="text-brand-700 hover:underline" href={`/o/${org}/accounting/journal/${e.entryId}`}>
                              #{e.entryNumber}
                            </Link>{" "}
                            <DateText date={e.date} /> · {e.component}
                          </li>
                        ))}
                      </ul>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        {can(ctx, "ledger.post") && (
          <Card title="Record a distribution">
            {beneficiaries.length === 0 ? (
              <p className="text-sm text-slate-500">Mark contacts as beneficiaries first (Sales → Customers or Purchases → Vendors, “beneficiary”).</p>
            ) : (
              <ActionForm action={distributionAction.bind(null, org)} className="grid gap-3 md:grid-cols-3" resetOnSuccess>
                <SelectField label="Beneficiary" name="beneficiaryId" required placeholder="Choose…" options={beneficiaries} />
                <SelectField label="Paid from" name="component" options={[{ value: "income", label: "Income" }, { value: "principal", label: "Principal" }]} />
                <SelectField label="Account paid from" name="paidFromAccountId" required placeholder="Choose…" options={await moneyAccountOptions(db, ctx.orgId)} />
                <TextField label="Amount" name="amount" inputMode="decimal" required />
                <TextField label="Date" name="date" type="date" defaultValue={to} required />
                <TextField label="Memo" name="memo" />
                <div className="md:col-span-3">
                  <SubmitButton>Record distribution</SubmitButton>
                  <p className="mt-2 text-xs text-slate-500">Posts Dr Distributions to Beneficiaries / Cr the account paid from, tagged with the beneficiary and component. It records a payment made; it does not make one.</p>
                </div>
              </ActionForm>
            )}
          </Card>
        )}
      </div>
    </>
  );
}
