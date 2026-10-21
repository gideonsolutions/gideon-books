import Link from "next/link";
import { currentSession, requireUser } from "@/lib/web/session";
import { listSessions } from "@/lib/auth/users";
import { Badge, Card, PageHeader } from "@/components/ui";
import { ActionButton, ActionForm, SubmitButton, TextField } from "@/components/client/forms";
import { MfaSetup } from "@/components/settings/mfa-setup";
import { formatDateTime } from "@/lib/money/format";
import { beginMfaAction, confirmMfaAction, disableMfaAction, nameAction, passwordAction, revokeOthersAction, revokeSessionAction } from "./actions";

export const metadata = { title: "Your account" };

export default async function Account() {
  const user = await requireUser("/account");
  const current = await currentSession();
  const sessions = await listSessions(user.id);
  return (
    <div className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-3xl px-4 py-8">
        <Link href="/orgs" className="text-sm text-slate-500 hover:text-brand-700">
          ← Organizations
        </Link>
        <div className="mt-2">
          <PageHeader title="Your account" description={user.email} />
        </div>
        <div className="space-y-6">
          <Card title="Profile">
            <ActionForm action={nameAction} className="flex items-end gap-3">
              <TextField label="Name" name="name" defaultValue={user.name} className="flex-1" required />
              <SubmitButton variant="secondary">Save</SubmitButton>
            </ActionForm>
          </Card>
          <Card title="Password">
            <ActionForm action={passwordAction} resetOnSuccess className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_1fr_auto] sm:items-end">
              <TextField label="Current password" name="current" type="password" autoComplete="current-password" required />
              <TextField label="New password" name="password" type="password" autoComplete="new-password" required hint="At least 10 characters." />
              <SubmitButton variant="secondary">Change</SubmitButton>
            </ActionForm>
          </Card>
          <Card title={<span className="flex items-center gap-2">Two-step verification {user.totpEnabledAt ? <Badge tone="green">on</Badge> : <Badge>off</Badge>}</span>}>
            {user.totpEnabledAt ? (
              <ActionForm action={disableMfaAction} className="flex items-end gap-3">
                <TextField label="Your password, to turn it off" name="password" type="password" required className="flex-1" />
                <SubmitButton variant="danger">Turn off</SubmitButton>
              </ActionForm>
            ) : (
              <>
                <p className="mb-3 text-sm text-slate-600">A code from an app on your phone, after your password, every time you sign in. Strongly recommended for anyone with access to books.</p>
                <MfaSetup begin={beginMfaAction} confirm={confirmMfaAction} />
              </>
            )}
          </Card>
          <Card title="Signed-in sessions" actions={sessions.length > 1 && <ActionButton action={revokeOthersAction} size="sm">Sign out everywhere else</ActionButton>}>
            <ul className="divide-y divide-slate-100 text-sm">
              {sessions.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-3 py-2">
                  <span>
                    <span className="block text-slate-800">{s.userAgent?.slice(0, 80) ?? "Unknown device"}</span>
                    <span className="text-xs text-slate-500">
                      {s.ip ?? "unknown address"} · last active {formatDateTime(s.lastSeenAt)}
                    </span>
                  </span>
                  {s.id === current?.session.id ? <Badge tone="blue">this one</Badge> : <ActionButton action={revokeSessionAction.bind(null, s.id)} size="sm" variant="ghost">Sign out</ActionButton>}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
