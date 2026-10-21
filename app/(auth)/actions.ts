"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  acceptInvitation,
  authenticate,
  completeMfa,
  createPasswordReset,
  createSession,
  createUser,
  invitationByToken,
  noteSignedIn,
  resetPassword,
  revokeSession,
} from "@/lib/auth/users";
import { queueEmail } from "@/lib/email/send";
import { getDb } from "@/lib/db/client";
import { orgsForUser } from "@/lib/orgs/orgs";
import { runAction, str, type ActionResult } from "@/lib/web/actions";
import { clientIp, cookieOptions, currentUser, MFA_COOKIE, SESSION_COOKIE } from "@/lib/web/session";
import { SESSION_DAYS } from "@/lib/auth/users";

function safeNext(next: string | null): string | null {
  // Only same-site paths: never an absolute URL (open redirect).
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return null;
  return next;
}

async function landingFor(userId: string): Promise<string> {
  const orgs = await orgsForUser(getDb(), userId);
  const real = orgs.find((o) => !o.org.isDemo) ?? orgs[0];
  if (!real) return "/orgs/new";
  return orgs.length > 1 ? "/orgs" : `/o/${real.org.slug}`;
}

export async function signInAction(_: ActionResult<unknown> | null, fd: FormData): Promise<ActionResult<{ href: string }>> {
  return runAction(async () => {
    const ip = await clientIp();
    const { user, needsMfa } = await authenticate(str(fd, "email") ?? "", String(fd.get("password") ?? ""), ip);
    const jar = await cookies();
    const next = safeNext(str(fd, "next"));
    if (needsMfa) {
      const { token } = await createSession(user.id, { ip, pendingMfa: true });
      jar.set(MFA_COOKIE, token, cookieOptions(600));
      return { href: `/two-step${next ? `?next=${encodeURIComponent(next)}` : ""}` };
    }
    const { token } = await createSession(user.id, { ip });
    jar.set(SESSION_COOKIE, token, cookieOptions(SESSION_DAYS * 86400));
    await noteSignedIn(user, ip);
    return { href: next ?? (await landingFor(user.id)) };
  });
}

export async function twoStepAction(_: ActionResult<unknown> | null, fd: FormData): Promise<ActionResult<{ href: string }>> {
  return runAction(async () => {
    const jar = await cookies();
    const pending = jar.get(MFA_COOKIE)?.value;
    if (!pending) redirect("/sign-in");
    const { token, user } = await completeMfa(pending, str(fd, "code") ?? "", await clientIp());
    jar.delete(MFA_COOKIE);
    jar.set(SESSION_COOKIE, token, cookieOptions(SESSION_DAYS * 86400));
    return { href: safeNext(str(fd, "next")) ?? (await landingFor(user.id)) };
  });
}

export async function signUpAction(_: ActionResult<unknown> | null, fd: FormData): Promise<ActionResult<{ href: string }>> {
  return runAction(async () => {
    const invite = str(fd, "invite");
    const ip = await clientIp();
    const invitation = invite ? await invitationByToken(invite) : null;
    const user = await createUser(
      { email: str(fd, "email") ?? "", name: str(fd, "name") ?? "", password: String(fd.get("password") ?? "") },
      { ip, viaInvitation: !!invitation },
    );
    const { token } = await createSession(user.id, { ip });
    (await cookies()).set(SESSION_COOKIE, token, cookieOptions(SESSION_DAYS * 86400));
    if (invitation && invite) {
      const org = await acceptInvitation(invite, user.id);
      return { href: `/o/${org.slug}` };
    }
    return { href: "/orgs/new" };
  });
}

export async function forgotPasswordAction(_: ActionResult<unknown> | null, fd: FormData): Promise<ActionResult<void>> {
  return runAction(async () => {
    const r = await createPasswordReset(str(fd, "email") ?? "");
    if (r) {
      const url = `${process.env.APP_URL ?? "http://localhost:3200"}/reset-password/${r.token}`;
      await queueEmail(getDb(), null, {
        to: r.user.email,
        subject: "Reset your Gideon Books password",
        text: `Someone asked to reset the password for ${r.user.email}.\n\nTo choose a new password, open this link within an hour:\n${url}\n\nIf it was not you, ignore this email; your password has not changed.`,
      });
    }
    // The same answer whether or not the account exists.
  }, "If that address has an account, a reset link is on its way. It works for one hour.");
}

export async function resetPasswordAction(_: ActionResult<unknown> | null, fd: FormData): Promise<ActionResult<{ href: string }>> {
  return runAction(async () => {
    await resetPassword(str(fd, "token") ?? "", String(fd.get("password") ?? ""));
    return { href: "/sign-in?reset=1" };
  });
}

export async function acceptInviteAction(_: ActionResult<unknown> | null, fd: FormData): Promise<ActionResult<{ href: string }>> {
  return runAction(async () => {
    const user = await currentUser();
    if (!user) redirect(`/sign-in?next=${encodeURIComponent(`/invite/${str(fd, "token")}`)}`);
    const org = await acceptInvitation(str(fd, "token") ?? "", user.id);
    return { href: `/o/${org.slug}` };
  });
}

export async function signOut() {
  const jar = await cookies();
  const t = jar.get(SESSION_COOKIE)?.value;
  if (t) await revokeSession(t);
  jar.delete(SESSION_COOKIE);
  redirect("/sign-in");
}
