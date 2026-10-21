"use client";

import { useActionState } from "react";
import { ActionForm, SubmitButton, TextField } from "@/components/client/forms";
import { buttonClass } from "@/components/ui";
import type { ActionResult } from "@/lib/web/actions";

export function MfaSetup({
  begin,
  confirm,
}: {
  begin: (prev: ActionResult<{ secret: string; url: string }> | null) => Promise<ActionResult<{ secret: string; url: string }>>;
  confirm: (prev: ActionResult<unknown> | null, fd: FormData) => Promise<ActionResult<unknown>>;
}) {
  const [state, start] = useActionState(begin, null);
  if (!state?.ok || !state.data) {
    return (
      <form action={start}>
        {state && !state.ok && <p className="mb-2 text-sm text-danger-700">{state.error}</p>}
        <button type="submit" className={buttonClass("primary")}>
          Set up two-step verification
        </button>
      </form>
    );
  }
  const groups = state.data.secret.match(/.{1,4}/g)?.join(" ");
  return (
    <div className="space-y-4">
      <ol className="list-decimal space-y-2 pl-5 text-sm text-slate-700">
        <li>
          In your authenticator app (1Password, Google Authenticator, Authy, …), add an account by entering this key:
          <div className="mt-1 rounded-md bg-slate-100 px-3 py-2 font-mono text-sm tracking-wider text-slate-900 select-all">{groups}</div>
          <div className="mt-1 text-xs text-slate-500">
            Or open this link on the device with the app: <a className="break-all text-brand-700 underline" href={state.data.url}>{state.data.url}</a>
          </div>
        </li>
        <li>Enter the six-digit code it shows.</li>
      </ol>
      <ActionForm action={confirm} className="flex items-end gap-2">
        <TextField label="Code" name="code" inputMode="numeric" autoComplete="one-time-code" required />
        <SubmitButton>Turn on</SubmitButton>
      </ActionForm>
    </div>
  );
}
