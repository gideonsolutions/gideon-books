import { ActionForm, SubmitButton, TextField } from "@/components/client/forms";
import { twoStepAction } from "../actions";

export const metadata = { title: "Two-step verification" };

export default async function TwoStep({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const sp = await searchParams;
  return (
    <>
      <h1 className="text-xl font-semibold text-slate-900">Two-step verification</h1>
      <p className="mt-2 text-sm text-slate-600">Enter the six-digit code from your authenticator app.</p>
      <ActionForm action={twoStepAction} className="mt-6 space-y-4">
        <input type="hidden" name="next" value={sp.next ?? ""} />
        <TextField label="Code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" required autoFocus />
        <SubmitButton className="w-full" pendingText="Checking…">
          Verify
        </SubmitButton>
      </ActionForm>
    </>
  );
}
