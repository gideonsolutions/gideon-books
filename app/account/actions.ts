"use server";

import { beginTotpEnrollment, changePassword, confirmTotpEnrollment, disableTotp, revokeAllSessions, revokeSessionById, updateUserName } from "@/lib/auth/users";
import { runAction, str, type ActionResult } from "@/lib/web/actions";
import { currentSession, requireUser } from "@/lib/web/session";
import { otpauthUrl } from "@/lib/auth/totp";

type R<T = unknown> = Promise<ActionResult<T>>;

export async function nameAction(_: unknown, fd: FormData): R {
  return runAction(async () => {
    const u = await requireUser();
    await updateUserName(u.id, str(fd, "name") ?? "");
  }, "Saved.");
}

export async function passwordAction(_: unknown, fd: FormData): R {
  return runAction(async () => {
    const s = await currentSession();
    if (!s) throw new Error("not signed in");
    await changePassword(s.user.id, String(fd.get("current") ?? ""), String(fd.get("password") ?? ""), s.session.id);
  }, "Password changed. Other sessions were signed out.");
}

export async function beginMfaAction(): R<{ secret: string; url: string }> {
  return runAction(async () => {
    const u = await requireUser();
    const secret = await beginTotpEnrollment(u.id);
    return { secret, url: otpauthUrl(secret, u.email) };
  });
}

export async function confirmMfaAction(_: unknown, fd: FormData): R {
  return runAction(async () => {
    const u = await requireUser();
    await confirmTotpEnrollment(u.id, str(fd, "code") ?? "");
  }, "Two-step verification is on.");
}

export async function disableMfaAction(_: unknown, fd: FormData): R {
  return runAction(async () => {
    const u = await requireUser();
    await disableTotp(u.id, String(fd.get("password") ?? ""));
  }, "Two-step verification is off.");
}

export async function revokeSessionAction(id: string): R {
  return runAction(async () => {
    const u = await requireUser();
    await revokeSessionById(u.id, id);
  }, "Signed out that session.");
}

export async function revokeOthersAction(): R {
  return runAction(async () => {
    const s = await currentSession();
    if (!s) throw new Error("not signed in");
    await revokeAllSessions(s.user.id, s.session.id);
  }, "Every other session was signed out.");
}
