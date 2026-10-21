import Link from "next/link";
import { redirect } from "next/navigation";
import { ActionForm, SubmitButton, TextField } from "@/components/client/forms";
import { Alert } from "@/components/ui";
import { currentUser } from "@/lib/web/session";
import { signupOpen } from "@/lib/auth/users";
import { signInAction } from "../actions";

export const metadata = { title: "Sign in" };

export default async function SignIn({ searchParams }: { searchParams: Promise<{ next?: string; reset?: string }> }) {
  const sp = await searchParams;
  if (await currentUser()) redirect(sp.next?.startsWith("/") && !sp.next.startsWith("//") ? sp.next : "/orgs");
  const open = await signupOpen();
  return (
    <>
      <h1 className="text-xl font-semibold text-slate-900">Sign in</h1>
      {sp.reset && (
        <div className="mt-4">
          <Alert tone="success">Your password was changed. Sign in with the new one.</Alert>
        </div>
      )}
      <ActionForm action={signInAction} className="mt-6 space-y-4">
        <input type="hidden" name="next" value={sp.next ?? ""} />
        <TextField label="Email" name="email" type="email" autoComplete="email" required autoFocus />
        <TextField label="Password" name="password" type="password" autoComplete="current-password" required />
        <SubmitButton className="w-full" pendingText="Signing in…">
          Sign in
        </SubmitButton>
      </ActionForm>
      <div className="mt-6 flex justify-between text-sm">
        <Link href="/forgot-password" className="text-brand-700 hover:underline">
          Forgot your password?
        </Link>
        {open && (
          <Link href="/sign-up" className="text-brand-700 hover:underline">
            Create an account
          </Link>
        )}
      </div>
    </>
  );
}
