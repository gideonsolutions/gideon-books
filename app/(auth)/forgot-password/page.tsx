import Link from "next/link";
import { ActionForm, SubmitButton, TextField } from "@/components/client/forms";
import { emailDeliveryConfigured } from "@/lib/email/send";
import { Alert } from "@/components/ui";
import { forgotPasswordAction } from "../actions";

export const metadata = { title: "Reset your password" };

export default function Forgot() {
  return (
    <>
      <h1 className="text-xl font-semibold text-slate-900">Reset your password</h1>
      <p className="mt-2 text-sm text-slate-600">We will email a link to choose a new one.</p>
      {!emailDeliveryConfigured() && (
        <div className="mt-4">
          <Alert tone="warning" title="This server does not send email">
            No email provider is configured, so the link will not arrive. Ask the server&apos;s administrator to reset your password with{" "}
            <code className="text-xs">npm run admin:create-user -- --reset</code>.
          </Alert>
        </div>
      )}
      <ActionForm action={forgotPasswordAction} className="mt-6 space-y-4" resetOnSuccess>
        <TextField label="Email" name="email" type="email" autoComplete="email" required autoFocus />
        <SubmitButton className="w-full">Send the link</SubmitButton>
      </ActionForm>
      <Link href="/sign-in" className="mt-6 inline-block text-sm text-brand-700 hover:underline">
        Back to sign in
      </Link>
    </>
  );
}
