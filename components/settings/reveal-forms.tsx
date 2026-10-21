"use client";

/** Forms whose result must be shown once: an invitation link, a new API token. */
import { useActionState, useState } from "react";
import { SelectField, SubmitButton, TextField, type Option } from "@/components/client/forms";
import { buttonClass, inputClass } from "@/components/ui";
import type { ActionResult } from "@/lib/web/actions";

type Act<T> = (prev: ActionResult<T> | null, fd: FormData) => Promise<ActionResult<T>>;

function Copy({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900" role="status">
      <div className="font-medium">{label}</div>
      <div className="mt-2 flex gap-2">
        <input readOnly value={value} className={`${inputClass} font-mono text-xs`} onFocus={(e) => e.currentTarget.select()} aria-label={label} />
        <button
          type="button"
          className={buttonClass("secondary", "sm")}
          onClick={() => {
            void navigator.clipboard?.writeText(value);
            setCopied(true);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

function ErrorBox({ state }: { state: ActionResult<unknown> | null }) {
  if (!state || state.ok) return null;
  return (
    <div role="alert" className="mb-3 rounded-md border border-danger-100 bg-danger-50 px-3 py-2 text-sm text-danger-700">
      {state.error}
    </div>
  );
}

export function InviteForm({ action, roles }: { action: Act<{ link: string }>; roles: Option[] }) {
  const [state, formAction] = useActionState(action, null);
  return (
    <form action={formAction} className="space-y-3">
      <ErrorBox state={state} />
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem_auto] sm:items-end">
        <TextField label="Email" name="email" type="email" required />
        <SelectField label="Role" name="role" options={roles} defaultValue="staff" />
        <SubmitButton pendingText="Inviting…">Invite</SubmitButton>
      </div>
      {state?.ok && state.data?.link && <Copy value={state.data.link} label="Invitation sent. If this server does not deliver email, share this link (valid 7 days):" />}
    </form>
  );
}

export function TokenForm({ action, roles }: { action: Act<{ token: string }>; roles: Option[] }) {
  const [state, formAction] = useActionState(action, null);
  return (
    <form action={formAction} className="space-y-3">
      <ErrorBox state={state} />
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem_10rem_auto] sm:items-end">
        <TextField label="Name" name="name" required placeholder="What will use it" />
        <SelectField label="Role" name="role" options={roles} defaultValue="read_only" />
        <SelectField
          label="Expires"
          name="expiresInDays"
          options={[
            { value: "30", label: "In 30 days" },
            { value: "90", label: "In 90 days" },
            { value: "365", label: "In a year" },
            { value: "", label: "Never" },
          ]}
          defaultValue="90"
        />
        <SubmitButton pendingText="Creating…">Create token</SubmitButton>
      </div>
      {state?.ok && state.data?.token && <Copy value={state.data.token} label="Copy the token now. It will not be shown again." />}
    </form>
  );
}
