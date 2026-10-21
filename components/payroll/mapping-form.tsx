"use client";

import { useState } from "react";
import { ActionForm, SelectField, SubmitButton, TextField, type Option } from "@/components/client/forms";
import type { ActionResult } from "@/lib/web/actions";

const SIDES: Record<string, { expense: boolean; liability: boolean }> = {
  gross_wages: { expense: true, liability: false },
  employee_withholding: { expense: false, liability: true },
  employee_deduction: { expense: false, liability: true },
  employer_tax: { expense: true, liability: true },
  employer_benefit: { expense: true, liability: true },
  reimbursement: { expense: true, liability: false },
  net_pay: { expense: false, liability: true },
};

/** Add or edit a payroll component mapping; the fields shown follow the component type. */
export function MappingForm({
  action,
  types,
  expenseAccounts,
  liabilityAccounts,
  defaults,
  submitLabel,
  lockType,
}: {
  action: (prev: ActionResult<unknown> | null, fd: FormData) => Promise<ActionResult<unknown>>;
  types: Option[];
  expenseAccounts: Option[];
  liabilityAccounts: Option[];
  defaults?: { componentType: string; componentCode: string; label: string; expenseAccountId: string; liabilityAccountId: string };
  submitLabel: string;
  lockType?: boolean;
}) {
  const [type, setType] = useState(defaults?.componentType ?? "gross_wages");
  const sides = SIDES[type] ?? { expense: true, liability: true };
  return (
    <ActionForm action={action} className="grid items-end gap-3 md:grid-cols-6" resetOnSuccess={!defaults}>
      <SelectField label="Component" name="componentType" options={types} value={type} onChange={(e) => setType(e.target.value)} disabled={lockType} className="md:col-span-2" />
      {lockType && <input type="hidden" name="componentType" value={type} />}
      <TextField label="Code" name="componentCode" required defaultValue={defaults?.componentCode ?? ""} readOnly={lockType} placeholder="e.g. overtime" hint={lockType ? undefined : "As in the file; * = default for the type."} />
      {sides.expense ? <SelectField label="Expense account" name="expenseAccountId" options={expenseAccounts} placeholder="Choose…" defaultValue={defaults?.expenseAccountId ?? ""} /> : <div />}
      {sides.liability ? (
        <SelectField label={type === "net_pay" ? "Net pay to" : "Liability account"} name="liabilityAccountId" options={liabilityAccounts} placeholder="Choose…" defaultValue={defaults?.liabilityAccountId ?? ""} />
      ) : (
        <div />
      )}
      <div className="flex gap-2">
        <input type="hidden" name="label" value={defaults?.label ?? ""} />
        <SubmitButton variant="secondary">{submitLabel}</SubmitButton>
      </div>
    </ActionForm>
  );
}
