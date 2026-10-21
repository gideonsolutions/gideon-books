"use client";

import { useState } from "react";
import { ActionForm, SelectField, SubmitButton, TextAreaField, TextField, type Option } from "@/components/client/forms";
import type { ActionResult } from "@/lib/web/actions";

export interface ProjectFormDefaults {
  name: string;
  code: string;
  customerId: string;
  status: string;
  billingMethod: string;
  hourlyRate: string;
  fixedFee: string;
  budgetAmount: string;
  startDate: string;
  endDate: string;
  description: string;
}

export function ProjectForm({
  action,
  customers,
  defaults,
  submitLabel,
}: {
  action: (prev: ActionResult<unknown> | null, fd: FormData) => Promise<ActionResult<unknown>>;
  customers: Option[];
  defaults: ProjectFormDefaults;
  submitLabel: string;
}) {
  const [method, setMethod] = useState(defaults.billingMethod);
  return (
    <ActionForm action={action} className="space-y-4">
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_10rem]">
        <TextField label="Name" name="name" required defaultValue={defaults.name} />
        <TextField label="Code" name="code" defaultValue={defaults.code} />
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <SelectField label="Customer" name="customerId" placeholder="—" options={customers} defaultValue={defaults.customerId} />
        <SelectField
          label="Billing"
          name="billingMethod"
          value={method}
          onChange={(e) => setMethod(e.target.value)}
          options={[
            { value: "time_and_materials", label: "Time and materials" },
            { value: "fixed_fee", label: "Fixed fee" },
            { value: "non_billable", label: "Not billable (internal)" },
          ]}
        />
        <SelectField
          label="Status"
          name="status"
          defaultValue={defaults.status || "active"}
          options={[
            { value: "active", label: "Active" },
            { value: "on_hold", label: "On hold" },
            { value: "completed", label: "Completed" },
            { value: "cancelled", label: "Cancelled" },
          ]}
        />
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        {method !== "non_billable" && <TextField label="Hourly rate" name="hourlyRate" inputMode="decimal" defaultValue={defaults.hourlyRate} hint="Default for time entries." />}
        {method === "fixed_fee" && <TextField label="Fixed fee" name="fixedFee" inputMode="decimal" required defaultValue={defaults.fixedFee} />}
        <TextField label="Cost budget" name="budgetAmount" inputMode="decimal" defaultValue={defaults.budgetAmount} hint="Compared with costs on the project." />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <TextField label="Starts" name="startDate" type="date" defaultValue={defaults.startDate} />
        <TextField label="Ends" name="endDate" type="date" defaultValue={defaults.endDate} />
      </div>
      <TextAreaField label="Description" name="description" defaultValue={defaults.description} rows={2} />
      <div className="flex justify-end">
        <SubmitButton>{submitLabel}</SubmitButton>
      </div>
    </ActionForm>
  );
}
