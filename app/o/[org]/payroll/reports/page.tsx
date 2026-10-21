import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { can, requirePermission } from "@/lib/context";
import { payrollLiabilityReport, payrollSummary } from "@/lib/payroll/reports";
import { listSettlements, payrollLiabilityAccounts } from "@/lib/payroll/settlements";
import { moneyAccountOptions } from "@/lib/web/options";
import { fiscalYearStart } from "@/lib/ledger/periods";
import { todayIn } from "@/lib/dates";
import { Alert, Card, DateText, Grid, Money, PageHeader, Stat, Table, Td, Th, buttonClass, inputClass } from "@/components/ui";
import { ActionForm, SelectField, SubmitButton, TextField } from "@/components/client/forms";
import { PayrollTabs } from "@/components/payroll/tabs";
import { recordLiabilityPaymentAction } from "../actions";

export const metadata = { title: "Payroll summary and liabilities" };

export default async function PayrollReports({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ from?: string; to?: string }> }) {
  const { org } = await params;
  const sp = await searchParams;
  const ctx = await orgCtx(org);
  requirePermission(ctx, "reports.read");
  const db = getDb();
  const today = todayIn(ctx.org.timezone);
  const valid = (d?: string) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : undefined);
  const from = valid(sp.from) ?? fiscalYearStart(today, ctx.org.fiscalYearStartMonth);
  const to = valid(sp.to) ?? today;
  const summary = await payrollSummary(db, ctx.orgId, from, to);
  const liab = await payrollLiabilityReport(db, ctx.orgId, from, to);
  const recent = await listSettlements(db, ctx.orgId, 20);
  const banks = await moneyAccountOptions(db, ctx.orgId);
  const liabilities = (await payrollLiabilityAccounts(db, ctx.orgId)).map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` }));
  const cur = ctx.org.baseCurrency;
  const base = `/o/${org}`;
  return (
    <>
      <PageHeader title="Payroll summary and liabilities" description={`Posted payroll paid from ${from} to ${to}, and what is owed on each payroll liability account, reconciled to the ledger.`} />
      <PayrollTabs org={org} current="reports" />
      <form method="get" className="mb-6 flex flex-wrap items-end gap-3 no-print">
        <label className="text-xs font-medium text-slate-600">
          From
          <input type="date" name="from" defaultValue={from} className={`${inputClass} mt-1`} />
        </label>
        <label className="text-xs font-medium text-slate-600">
          To
          <input type="date" name="to" defaultValue={to} className={`${inputClass} mt-1`} />
        </label>
        <button className={buttonClass("secondary")}>Apply</button>
      </form>
      <div className="mb-6">
        <Grid cols={4}>
          <Stat label="Gross wages" value={<Money amount={summary.totals.grossWages} currency={cur} />} />
          <Stat label="Employer taxes" value={<Money amount={summary.totals.employerTaxes} currency={cur} />} hint={<>Benefits <Money amount={summary.totals.employerBenefits} currency={cur} /></>} />
          <Stat label="Net pay" value={<Money amount={summary.totals.netPay} currency={cur} />} />
          <Stat label="Total employer cost" value={<Money amount={summary.totals.employerCost} currency={cur} />} hint="Gross + employer taxes and benefits + reimbursements" />
        </Grid>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="By component" padded={false}>
          <Table className="rounded-none border-0 shadow-none">
            <thead>
              <tr>
                <Th>Component</Th>
                <Th align="right">Amount</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {summary.byComponent.map((c) => (
                <tr key={`${c.type}${c.code}`}>
                  <Td>
                    {c.label}
                    {c.code !== "net_pay" && <span className="text-slate-500"> · {c.code}</span>}
                  </Td>
                  <Td align="right"><Money amount={c.amount} currency={cur} /></Td>
                </tr>
              ))}
              {summary.byComponent.length === 0 && (
                <tr>
                  <Td colSpan={2} className="text-slate-500">No payroll in this range.</Td>
                </tr>
              )}
            </tbody>
          </Table>
        </Card>
        <div className="space-y-6">
          <Card title="Employer cost by department" padded={false}>
            <Table className="rounded-none border-0 shadow-none">
              <tbody className="divide-y divide-slate-100">
                {summary.byDepartment.map((d) => (
                  <tr key={d.name}>
                    <Td>{d.name}</Td>
                    <Td align="right"><Money amount={d.amount} currency={cur} /></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
          <Card title="Employer cost by project" padded={false}>
            <Table className="rounded-none border-0 shadow-none">
              <tbody className="divide-y divide-slate-100">
                {summary.byProject.map((d) => (
                  <tr key={d.name}>
                    <Td>{d.id ? <Link className="text-brand-700 hover:underline" href={`${base}/projects/${d.id}`}>{d.name}</Link> : d.name}</Td>
                    <Td align="right"><Money amount={d.amount} currency={cur} /></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </div>
      </div>

      <h2 className="mb-2 mt-8 text-sm font-semibold uppercase tracking-wide text-slate-500">Payroll liabilities</h2>
      <div className="mb-3">
        {liab.reconciled ? <Alert tone="success">Every payroll liability agrees with the ledger at {to}.</Alert> : <Alert tone="danger">A payroll liability differs from the ledger; see the difference column.</Alert>}
      </div>
      <Table>
        <thead>
          <tr>
            <Th>Account</Th>
            <Th align="right">Opening</Th>
            <Th align="right">Accrued by payroll</Th>
            <Th align="right">Paid</Th>
            <Th align="right">Other</Th>
            <Th align="right">Owed at {to}</Th>
            <Th align="right">Ledger</Th>
            <Th align="right">Difference</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {liab.rows.map((r) => (
            <tr key={r.accountId}>
              <Td>
                {r.code} {r.name}
              </Td>
              <Td align="right"><Money amount={r.opening} currency={cur} /></Td>
              <Td align="right"><Money amount={r.accrued} currency={cur} /></Td>
              <Td align="right"><Money amount={r.paid} currency={cur} /></Td>
              <Td align="right"><Money amount={r.other} currency={cur} showZero={false} /></Td>
              <Td align="right" className="font-medium"><Money amount={r.closing} currency={cur} /></Td>
              <Td align="right">
                <Link className="hover:underline" href={`${base}/reports/general-ledger?account=${r.accountId}&to=${to}`}>
                  <Money amount={r.ledger} currency={cur} />
                </Link>
              </Td>
              <Td align="right"><Money amount={r.difference} currency={cur} /></Td>
            </tr>
          ))}
        </tbody>
      </Table>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {can(ctx, "payroll.import") && (
          <Card title="Record a liability payment">
            <ActionForm action={recordLiabilityPaymentAction.bind(null, org, null)} className="grid gap-3 sm:grid-cols-2" resetOnSuccess>
              <SelectField label="Liability" name="liabilityAccountId" required placeholder="Choose…" options={liabilities} />
              <TextField label="Date" name="date" type="date" required defaultValue={today} />
              <SelectField label="From account" name="bankAccountId" required placeholder="Choose…" options={banks} />
              <TextField label="Amount" name="amount" inputMode="decimal" required />
              <TextField label="Reference" name="reference" />
              <TextField label="Memo" name="memo" />
              <div className="sm:col-span-2">
                <SubmitButton>Record payment</SubmitButton>
                <p className="mt-2 text-xs text-slate-500">Recording a payment does not send money.</p>
              </div>
            </ActionForm>
          </Card>
        )}
        <Card title="Recent payroll payments">
          {recent.length === 0 ? (
            <p className="text-sm text-slate-500">None recorded.</p>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {recent.map(({ s, account }) => (
                <li key={s.id} className="flex justify-between gap-2 py-1.5">
                  <span>
                    <DateText date={s.settlementDate} /> · {s.kind === "net_pay" ? "Net pay" : account.name}
                    {s.status === "void" && <span className="ml-1 text-xs text-danger-700">(void)</span>}
                    {s.runId && (
                      <Link className="ml-1 text-xs text-brand-700 hover:underline" href={`${base}/payroll/${s.runId}`}>
                        run
                      </Link>
                    )}
                  </span>
                  <Money amount={s.amount} currency={cur} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
