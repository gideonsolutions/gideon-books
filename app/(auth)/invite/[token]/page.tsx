import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/client/forms";
import { buttonClass } from "@/components/ui";
import { invitationByToken } from "@/lib/auth/users";
import { currentUser } from "@/lib/web/session";
import { ROLE_LABELS } from "@/lib/authz/permissions";
import { acceptInviteAction } from "../../actions";

export const metadata = { title: "Invitation" };

export default async function Invite({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const inv = await invitationByToken(token);
  if (!inv) {
    return (
      <>
        <h1 className="text-xl font-semibold text-slate-900">This invitation is no longer valid</h1>
        <p className="mt-2 text-sm text-slate-600">It may have expired, been used, or been withdrawn. Ask for a new one.</p>
      </>
    );
  }
  const user = await currentUser();
  return (
    <>
      <h1 className="text-xl font-semibold text-slate-900">Join {inv.org.name}</h1>
      <p className="mt-2 text-sm text-slate-600">
        You are invited as <strong>{ROLE_LABELS[inv.invitation.role]}</strong> ({inv.invitation.email}).
      </p>
      {user ? (
        <ActionForm action={acceptInviteAction} className="mt-6">
          <input type="hidden" name="token" value={token} />
          <SubmitButton className="w-full">Accept and open {inv.org.name}</SubmitButton>
        </ActionForm>
      ) : (
        <div className="mt-6 flex gap-3">
          <Link className={buttonClass("primary")} href={`/sign-up?invite=${token}`}>
            Create an account
          </Link>
          <Link className={buttonClass("secondary")} href={`/sign-in?next=${encodeURIComponent(`/invite/${token}`)}`}>
            I have an account
          </Link>
        </div>
      )}
    </>
  );
}
