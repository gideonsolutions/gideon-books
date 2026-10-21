/**
 * The signed-in person and the organization a page is for. Every page and
 * server action resolves these itself (on the server) rather than trusting a
 * path check made elsewhere.
 */
import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { sessionFromToken, type User } from "@/lib/auth/users";
import { membershipFor, orgBySlug } from "@/lib/orgs/orgs";
import { userCtx, type Ctx } from "@/lib/context";

export const SESSION_COOKIE = "gb_session";
export const MFA_COOKIE = "gb_mfa";

export function cookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production" && !process.env.APP_URL?.startsWith("http://"),
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

export async function clientIp(): Promise<string | null> {
  const h = await headers();
  const fwd = h.get("x-forwarded-for");
  if (fwd && process.env.TRUST_PROXY !== "false") return fwd.split(",")[0]!.trim();
  return h.get("x-real-ip");
}

export const currentSession = cache(async () => {
  const jar = await cookies();
  return sessionFromToken(jar.get(SESSION_COOKIE)?.value);
});

export async function currentUser(): Promise<User | null> {
  const s = await currentSession();
  return s && !s.session.pendingMfa ? s.user : null;
}

/** The signed-in user, or a redirect to sign in (returning here after). */
export async function requireUser(returnTo?: string): Promise<User> {
  const u = await currentUser();
  if (!u) redirect(`/sign-in${returnTo ? `?next=${encodeURIComponent(returnTo)}` : ""}`);
  return u;
}

/** The context for `slug` as the signed-in member; 404 if they are not a member. */
export const orgCtx = cache(async (slug: string): Promise<Ctx> => {
  const user = await requireUser(`/o/${slug}`);
  const org = await orgBySlug(getDb(), slug);
  if (!org || org.archivedAt) notFound();
  const role = await membershipFor(getDb(), org.id, user.id);
  if (!role) notFound();
  return userCtx(org, user.id, role, user.email, "ui", await clientIp());
});
