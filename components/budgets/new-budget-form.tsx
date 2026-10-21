"use client";

import { useState } from "react";
import { ActionForm, SelectField, SubmitButton, TextAreaField, TextField, type Option } from "@/components/client/forms";
import { formatDate } from "@/lib/money/format";
import type { ActionResult } from "@/lib/web/actions";

export function NewBudgetForm({ action, years, defaultYear, existing, basis }: { action: (p: ActionResult<unknown> | null, fd: FormData) => Promise<ActionResult<unknown>>; years: string[]; defaultYear: string; existing: Option[]; basis: string }) {
  const [start, setStart] = useState("actuals");
  return (
    <ActionForm action={action} className="space-y-4">
      <TextField label="Name" name="name" required defaultValue={`Budget ${defaultYear.slice(0, 4)}`} />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField label="Fiscal year starting" name="fiscalYearStart" defaultValue={defaultYear} options={years.map((y) => ({ value: y, label: formatDate(y) }))} />
        <SelectField
          label="Budget by"
          name="dimension"
          placeholder="Account only"
          options={[
            { value: "project", label: "Project" },
            { value: "class", label: "Class" },
            { value: "department", label: "Department" },
            { value: "location", label: "Location" },
            { value: "fund", label: "Fund" },
          ]}
        />
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-slate-800">Start from</legend>
        {[
          ["actuals", "Last year's actual results"],
          ["budget", "Another budget"],
          ["none", "Nothing — enter every amount"],
        ].map(([v, l]) => (
          <label key={v} className="flex items-center gap-2 text-sm">
            <input type="radio" name="start" value={v} checked={start === v} onChange={() => setStart(v!)} /> {l}
          </label>
        ))}
      </fieldset>
      {start === "actuals" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Adjust by (%)" name="adjustPercent" defaultValue="0" inputMode="decimal" hint="e.g. 5 for 5% more, -10 for 10% less." />
          <SelectField
            label="Actuals basis"
            name="basis"
            defaultValue={basis}
            options={[
              { value: "accrual", label: "Accrual" },
              { value: "cash", label: "Cash" },
            ]}
          />
        </div>
      )}
      {start === "budget" && <SelectField label="Copy from" name="copyBudgetId" required options={existing} placeholder="Choose…" />}
      <TextAreaField label="Notes" name="notes" rows={2} />
      <div className="flex justify-end">
        <SubmitButton>Create budget</SubmitButton>
      </div>
    </ActionForm>
  );
}
