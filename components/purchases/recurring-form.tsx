import { ActionForm, CheckboxField, SelectField, SubmitButton, TextField, type Option } from "@/components/client/forms";
import type { ActionResult } from "@/lib/web/actions";

const FREQUENCIES: Option[] = [
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "yearly", label: "Yearly" },
];

/** The schedule of a recurring bill, and the bill it copies. */
export function RecurringForm({
  action,
  bills,
  defaults,
  editing,
}: {
  action: (prev: ActionResult<unknown> | null, fd: FormData) => Promise<ActionResult<unknown>>;
  bills: Option[];
  defaults: { name: string; frequency: string; interval: string; startDate: string; endDate: string; maxOccurrences: string; autoIssue: boolean; sourceBillId: string };
  editing: boolean;
}) {
  return (
    <ActionForm action={action} className="space-y-4">
      <TextField label="Name" name="name" required defaultValue={defaults.name} hint="E.g. “Office rent”." />
      <div className="grid gap-4 sm:grid-cols-3">
        <SelectField label="Repeats" name="frequency" options={FREQUENCIES} defaultValue={defaults.frequency} />
        <TextField label="Every" name="interval" type="number" min={1} max={52} defaultValue={defaults.interval} hint="1 = every period, 2 = every other…" />
        <TextField label="First bill on" name="startDate" type="date" required defaultValue={defaults.startDate} hint={editing ? "Fixed once a bill has been produced." : undefined} />
        <TextField label="Last date (optional)" name="endDate" type="date" defaultValue={defaults.endDate} />
        <TextField label="Number of bills (optional)" name="maxOccurrences" type="number" min={1} defaultValue={defaults.maxOccurrences} />
      </div>
      <SelectField
        label={editing ? "Replace the contents with a copy of" : "Each bill copies"}
        name="sourceBillId"
        options={bills}
        placeholder={editing ? "Keep the current contents" : "Choose a bill…"}
        defaultValue={defaults.sourceBillId}
        required={!editing}
        hint="Vendor, lines, accounts, tax codes and dimensions are copied; each bill gets its own date and due date."
      />
      <CheckboxField label="Post each bill automatically" name="autoIssue" defaultChecked={defaults.autoIssue} hint="Otherwise each one is created as a draft for you to check and post." />
      <div className="flex justify-end">
        <SubmitButton>{editing ? "Save schedule" : "Create schedule"}</SubmitButton>
      </div>
    </ActionForm>
  );
}
