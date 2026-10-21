import Link from "next/link";
import { ActionForm, SubmitButton, TextField } from "@/components/client/forms";
import { Alert } from "@/components/ui";
import { invitationByToken, signupOpen } from "@/lib/auth/users";
import { signUpAction } from "../actions";

export const metadata = { title: "Create an account" };

export default async function SignUp({ searchParams }: { searchParams: Promise<{ invite?: string }> }) {
  const sp = await searchParams;
  const invitation = sp.invite ? await invitationByToken(sp.invite) : null;
  const open = await signupOpen();
  if (!open && !invitation) {
    return (
      <>
        <h1 className="text-xl font-semibold text-slate-900">Sign-up is by invitation</h1>
        <p className="mt-3 text-sm text-slate-600">This server only accepts new accounts through an invitation link from an organization&apos;s administrator.</p>
        <Link href="/sign-in" className="mt-6 inline-block text-sm text-brand-700 hover:underline">
          Sign in instead
        </Link>
      </>
    );
  }
  return (
    <>
      <h1 className="text-xl font-semibold text-slate-900">Create your account</h1>
      {invitation && (
        <div className="mt-4">
          <Alert tone="info">
            You were invited to <strong>{invitation.org.name}</strong> as {invitation.invitation.role.replace("_", "-")}. Use {invitation.invitation.email}.
          </Alert>
        </div>
      )}
      <ActionForm action={signUpAction} className="mt-6 space-y-4">
        {sp.invite && <input type="hidden" name="invite" value={sp.invite} />}
        <TextField label="Your name" name="name" autoComplete="name" required autoFocus />
        <TextField label="Email" name="email" type="email" autoComplete="email" required defaultValue={invitation?.invitation.email} />
        <TextField label="Password" name="password" type="password" autoComplete="new-password" required hint="At least 10 characters. A few words strung together works well." />
        <SubmitButton className="w-full" pendingText="Creating…">
          Create account
        </SubmitButton>
      </ActionForm>
      <p className="mt-6 text-sm text-slate-600">
        Already have an account?{" "}
        <Link href="/sign-in" className="text-brand-700 hover:underline">
          Sign in
        </Link>
      </p>
    </>
  );
}
