import { orgCtx } from "@/lib/web/session";
import { requirePermission } from "@/lib/context";
import { ADAPTERS } from "@/lib/payroll/adapters";
import { Card, PageHeader } from "@/components/ui";
import { ActionForm, SelectField, SubmitButton, TextAreaField } from "@/components/client/forms";
import { PayrollTabs } from "@/components/payroll/tabs";
import { uploadPayrollAction } from "../actions";

export const metadata = { title: "Import a payroll" };

const EXAMPLE = `run_id,pay_date,period_start,period_end,employee_id,employee_name,department,gross:regular,withholding:federal_income_tax,withholding:social_security,withholding:medicare,employer_tax:social_security,employer_tax:medicare,net_pay
2026-01-A,2026-01-31,2026-01-01,2026-01-31,E1,Ada Lovelace,,4000.00,500.00,248.00,58.00,248.00,58.00,3194.00`;

export default async function ImportPayroll({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await orgCtx(org);
  requirePermission(ctx, "payroll.import");
  return (
    <>
      <PageHeader title="Import a payroll" description="Upload what your payroll provider calculated. You will see the entry it makes and every problem with the file before anything is posted." />
      <PayrollTabs org={org} current="import" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <Card title="The file">
          <ActionForm action={uploadPayrollAction.bind(null, org)} className="space-y-4">
            <SelectField label="Format" name="adapter" defaultValue="generic_csv" options={ADAPTERS.map((a) => ({ value: a.key, label: a.label }))} />
            <label className="block text-sm font-medium text-slate-800">
              Payroll file (CSV or JSON, up to 5 MB)
              <input type="file" name="file" accept=".csv,.json,text/csv,application/json" className="mt-1 block w-full text-sm" />
            </label>
            <TextAreaField label="…or paste its contents" name="content" rows={6} placeholder={EXAMPLE} />
            <div className="flex justify-end">
              <SubmitButton pendingText="Reading…">Read and preview</SubmitButton>
            </div>
          </ActionForm>
        </Card>
        <Card title="The format">
          <div className="space-y-3 text-sm text-slate-700">
            <p>One run per file. Employee-level CSV: one row per employee with these columns:</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                <code>run_id</code>, <code>pay_date</code>, <code>period_start</code>, <code>period_end</code> (dates as YYYY-MM-DD)
              </li>
              <li>
                <code>employee_id</code>, <code>employee_name</code>, optional <code>department</code>, <code>class</code>, <code>location</code>, <code>project</code> (names or codes that exist here)
              </li>
              <li>
                Amount columns named <code>gross:…</code>, <code>withholding:…</code>, <code>deduction:…</code>, <code>employer_tax:…</code>, <code>employer_benefit:…</code>, <code>reimbursement:…</code>, and <code>net_pay</code>
              </li>
            </ul>
            <p>Each employee must satisfy gross − withholdings − deductions + reimbursements = net pay, to the cent.</p>
            <p>
              A summary CSV (<code>component_type</code>, <code>component_code</code>, <code>amount</code> per row) and JSON are also accepted. The full specification is in <code>docs/payroll-import-format.md</code>.
            </p>
            <p className="text-xs text-slate-500">
              Provider-specific formats (for example a Gusto export) are not built in: their column layouts were not verified, so they would be guesses. Export or convert to this format instead.
            </p>
          </div>
        </Card>
      </div>
    </>
  );
}
