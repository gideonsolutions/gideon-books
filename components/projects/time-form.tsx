"use client";

import { ActionForm, CheckboxField, SelectField, SubmitButton, TextField, type Option } from "@/components/client/forms";
import type { ActionResult } from "@/lib/web/actions";

/** Record (or edit) a time entry. */
export function TimeForm({
  action,
  projects,
  people,
  defaults,
  submitLabel = "Record time",
}: {
  action: (prev: ActionResult<unknown> | null, fd: FormData) => Promise<ActionResult<unknown>>;
  projects: Option[];
  people: Option[];
  defaults: { projectId: string; workDate: string; person: string; hours: string; rate: string; billable: boolean; description: string };
  submitLabel?: string;
}) {
  return (
    <ActionForm action={action} className="grid items-end gap-3 md:grid-cols-6" resetOnSuccess={submitLabel === "Record time"}>
      <SelectField label="Project" name="projectId" required placeholder="Choose…" options={projects} defaultValue={defaults.projectId} className="md:col-span-2" />
      <TextField label="Date" name="workDate" type="date" required defaultValue={defaults.workDate} />
      <SelectField label="Who" name="person" required options={people} defaultValue={defaults.person} />
      <TextField label="Hours" name="hours" required inputMode="decimal" defaultValue={defaults.hours} placeholder="1.5" />
      <TextField label="Rate" name="rate" inputMode="decimal" defaultValue={defaults.rate} placeholder="Project rate" />
      <TextField label="What was done" name="description" defaultValue={defaults.description} className="md:col-span-4" />
      <div className="md:col-span-1">
        <input type="hidden" name="billableSet" value="1" />
        <CheckboxField label="Billable" name="billable" defaultChecked={defaults.billable} />
      </div>
      <div className="md:col-span-1">
        <SubmitButton>{submitLabel}</SubmitButton>
      </div>
    </ActionForm>
  );
}
