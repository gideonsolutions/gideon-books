import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { can } from "@/lib/context";
import { getRun } from "@/lib/payroll/imports";
import { COMPONENT_LABELS } from "@/lib/payroll/mappings";
import { netPayOutstanding, payrollLiabilityAccounts, settlementsForRun } from "@/lib/payroll/settlements";
import { moneyAccountOptions } from "@/lib/web/options";
import { listAudit } from "@/lib/audit";
import { listAttachments } from "@/lib/storage/attachments";
import { todayIn } from "@/lib/dates";
import { Decimal } from "@/lib/money/decimal";
import { Alert, Badge, Card, DateText, DescriptionList, Money, PageHeader, Table, Td, Th } from "@/components/ui";
import { ActionForm, ConfirmButton, SelectField, SubmitButton, TextField } from "@/components/client/forms";
import { PayrollTabs } from "@/components/payroll/tabs";
import { Attachments } from "@/components/attachments";
import { AuditTrail } from "@/components/audit-trail";
import { recordLiabilityPaymentAction, recordNetPayAction, voidPayrollRunAction, voidPayrollSettlementAction } from "../actions";
import type { PayrollComponentType } from "@/lib/db/schema/payroll";

export const metadata = { title: "Payroll run" };

export default async function PayrollRun({ params }: { params: Promise<{ org: string; id: string }> }) {
  const { org, id } = await params;
  const ctx = await orgCtx(org);
  const db = getDb();
  const { run, lines } = await getRun(db, ctx.orgId, id);
  const settlements = await settlementsForRun(db, ctx.orgId, id);
  const { clearingAccountId, outstanding } = await netPayOutstanding(db, ctx.orgId, id);
  const banks = await moneyAccountOptions(db, ctx.orgId);
  const liabilities = (await payrollLiabilityAccounts(db, ctx.orgId)).filter((a) => a.id !== clearingAccountId).map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` }));
  const history = await listAudit(db, ctx.orgId, { entityType: "payroll_run", entityId: id });
  const files = await listAttachments(db, ctx.orgId, "payroll_run", id);
  const today = todayIn(ctx.org.timezone);
  const base = `/o/${org}`;
  const cur = ctx.org.baseCurrency;
  const may = can(ctx, "payroll.import");
  // Employee totals.
  const employees = new Map<string, { name: string; t: Record<string, Decimal> }>();
  for (const l of lines) {
    const key = l.employeeRef ?? "summary";
    const e = employees.get(key) ?? { name: l.employeeName ?? l.employeeRef ?? "Summary", t: {} };
    e.t[l.componentType] = (e.t[l.componentType] ?? Decimal.ZERO).add(l.amount);
    employees.set(key, e);
  }
  const cols: PayrollComponentType[] = ["gross_wages", "employee_withholding", "employee_deduction", "reimbursement", "net_pay", "employer_tax", "employer_benefit"];
  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            Payroll {run.providerRunId} <Badge tone={run.status === "posted" ? "green" : "red"}>{run.status}</Badge>
          </span>
        }
        back={{ href: `${base}/payroll`, label: "Payroll runs" }}
        actions={
          may &&
          run.status === "posted" && (
            <ConfirmButton
              action={voidPayrollRunAction.bind(null, org, id)}
              label="Void run"
              title="Void this payroll run?"
              body="Its entry is reversed on the date you choose. Then the same run (or a corrected file) can be imported again. Net pay and liability payments recorded against it must be voided first."
              dateLabel="Reversal date"
              defaultDate={today < run.payDate ? run.payDate : today}
              reasonLabel="Why is it being voided?"
              confirmLabel="Void run"
              variant="danger"
            />
          )
        }
      />
      <PayrollTabs org={org} current="runs" />
      {run.status === "void" && (
        <div className="mb-4">
          <Alert tone="warning">Voided: {run.voidReason}</Alert>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          <Card title="Totals">
            <DescriptionList
              items={[
                { label: "Pay date", value: <DateText date={run.payDate} /> },
                { label: "Period", value: <><DateText date={run.periodStart} /> – <DateText date={run.periodEnd} /></> },
                { label: "Gross wages", value: <Money amount={run.grossWages} currency={cur} /> },
                { label: "Employee withholdings", value: <Money amount={run.employeeWithholdings} currency={cur} /> },
                { label: "Employee deductions", value: <Money amount={run.employeeDeductions} currency={cur} /> },
                { label: "Reimbursements", value: <Money amount={run.reimbursements} currency={cur} /> },
                { label: "Net pay", value: <Money amount={run.netPay} currency={cur} /> },
                { label: "Employer taxes", value: <Money amount={run.employerTaxes} currency={cur} /> },
                { label: "Employer benefits", value: <Money amount={run.employerBenefits} currency={cur} /> },
                {
                  label: "Entry",
                  value: run.journalEntryId ? (
                    <Link className="text-brand-700 hover:underline" href={`${base}/accounting/journal/${run.journalEntryId}`}>
                      View posted entry
                    </Link>
                  ) : (
                    "—"
                  ),
                },
                { label: "Source", value: `${run.provider.replace("_", " ")} · ${run.fileName ?? ""}` },
              ]}
            />
          </Card>
          <Card title="By employee" padded={false}>
            <Table className="rounded-none border-0 shadow-none">
              <thead>
                <tr>
                  <Th>Employee</Th>
                  {cols.map((c) => (
                    <Th key={c} align="right">
                      {COMPONENT_LABELS[c].replace("Employee ", "").replace("Employer ", "Er. ")}
                    </Th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {[...employees.values()].map((e) => (
                  <tr key={e.name}>
                    <Td>{e.name}</Td>
                    {cols.map((c) => (
                      <Td key={c} align="right">
                        <Money amount={(e.t[c] ?? Decimal.ZERO).toString()} currency={cur} showZero={false} />
                      </Td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
          <Card title="Payments recorded against this run">
            {settlements.length === 0 ? (
              <p className="text-sm text-slate-500">None yet.</p>
            ) : (
              <ul className="divide-y divide-slate-100 text-sm">
                {settlements.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>
                      <DateText date={s.settlementDate} /> · {s.kind === "net_pay" ? "Net pay" : "Liability payment"} · <Money amount={s.amount} currency={cur} /> {s.reference && <span className="text-slate-500">({s.reference})</span>}{" "}
                      {s.status === "void" && <Badge tone="red">void</Badge>}
                    </span>
                    {may && s.status === "posted" && (
                      <ConfirmButton
                        action={voidPayrollSettlementAction.bind(null, org, s.id)}
                        label="Void"
                        size="sm"
                        title="Void this payment record?"
                        body="Its entry is reversed. Nothing is sent or refunded."
                        dateLabel="Date"
                        defaultDate={today}
                        reasonLabel="Why?"
                        confirmLabel="Void"
                      />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <div className="space-y-6">
          {may && run.status === "posted" && clearingAccountId && (
            <Card title="Record net pay disbursed">
              <p className="mb-3 text-sm text-slate-600">
                Outstanding: <Money amount={outstanding.toString()} currency={cur} />. Recording it clears net pay against the bank account. Gideon Books does not send money.
              </p>
              {outstanding.isPositive() ? (
                <ActionForm action={recordNetPayAction.bind(null, org, id)} className="space-y-3" resetOnSuccess>
                  <TextField label="Date" name="date" type="date" required defaultValue={run.payDate} />
                  <SelectField label="From account" name="bankAccountId" required placeholder="Choose…" options={banks} />
                  <TextField label="Amount" name="amount" inputMode="decimal" placeholder={outstanding.toString()} hint="Blank: all that is outstanding." />
                  <TextField label="Reference" name="reference" />
                  <SubmitButton>Record net pay</SubmitButton>
                </ActionForm>
              ) : (
                <p className="text-sm text-emerald-700">Net pay is fully recorded as paid.</p>
              )}
            </Card>
          )}
          {may && run.status === "posted" && (
            <Card title="Record a liability payment">
              <p className="mb-3 text-sm text-slate-600">A tax deposit or benefit remittance for this run.</p>
              <ActionForm action={recordLiabilityPaymentAction.bind(null, org, id)} className="space-y-3" resetOnSuccess>
                <SelectField label="Liability" name="liabilityAccountId" required placeholder="Choose…" options={liabilities} />
                <TextField label="Date" name="date" type="date" required defaultValue={today} />
                <SelectField label="From account" name="bankAccountId" required placeholder="Choose…" options={banks} />
                <TextField label="Amount" name="amount" inputMode="decimal" required />
                <TextField label="Reference" name="reference" placeholder="e.g. EFTPS confirmation" />
                <SubmitButton>Record payment</SubmitButton>
              </ActionForm>
            </Card>
          )}
          <Attachments org={org} entityType="payroll_run" entityId={id} files={files} canUpload={may} />
          <AuditTrail events={history} />
        </div>
      </div>
    </>
  );
}
