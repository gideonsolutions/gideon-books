import { ActionForm, SubmitButton, TextField } from "@/components/client/forms";
import { resetPasswordAction } from "../../actions";

export const metadata = { title: "Choose a new password" };

export default async function Reset({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <>
      <h1 className="text-xl font-semibold text-slate-900">Choose a new password</h1>
      <ActionForm action={resetPasswordAction} className="mt-6 space-y-4">
        <input type="hidden" name="token" value={token} />
        <TextField label="New password" name="password" type="password" autoComplete="new-password" required hint="At least 10 characters." />
        <SubmitButton className="w-full">Save password</SubmitButton>
      </ActionForm>
    </>
  );
}
