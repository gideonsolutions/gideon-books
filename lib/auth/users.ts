/**
 * Accounts and sessions: sign-up, sign-in with throttling and optional
 * two-step verification, sessions held as hashed tokens, password reset,
 * invitations, and API tokens.
 */
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { getDb, withTransaction, type DbOrTx } from "@/lib/db/client";
import { apiTokens, authThrottle, invitations, memberships, organizations, sessions, userTokens, users, type Role } from "@/lib/db/schema/core";
import { audit, auditInstance } from "@/lib/audit";
import { requirePermission, type Ctx } from "@/lib/context";
import { ConflictError, ForbiddenError, NotFoundError, RateLimitError, UnauthorizedError, ValidationError } from "@/lib/errors";
import { canGrantRole, ROLE_RANK } from "@/lib/authz/permissions";
import { decryptSecret, encryptSecret, randomToken, sha256Hex } from "@/lib/crypto/secrets";
import { hashPassword, passwordProblem, verifyPassword } from "./password";
import { newTotpSecret, verifyTotp } from "./totp";

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const SESSION_DAYS = 14;

export function normalizeEmail(e: string): string {
  return e.trim().toLowerCase();
}

export async function findUserByEmail(db: DbOrTx, email: string): Promise<User | null> {
  const [u] = await db.select().from(users).where(sql`lower(${users.email}) = ${normalizeEmail(email)}`);
  return u ?? null;
}

export async function getUser(db: DbOrTx, id: string): Promise<User> {
  const [u] = await db.select().from(users).where(eq(users.id, id));
  if (!u) throw new NotFoundError("The user");
  return u;
}

/** Whether a new person may sign up without an invitation. */
export async function signupOpen(): Promise<boolean> {
  const mode = (process.env.SIGNUP_MODE ?? "open").toLowerCase();
  if (mode === "open") return true;
  // invite_only: only the very first account (the instance administrator) may sign up.
  const [r] = await getDb().select({ n: sql<number>`count(*)::int` }).from(users);
  return (r?.n ?? 0) === 0;
}

export async function createUser(input: { email: string; name: string; password: string }, opts: { ip?: string | null; viaInvitation?: boolean } = {}): Promise<User> {
  const fields: Record<string, string> = {};
  const email = normalizeEmail(input.email ?? "");
  if (!EMAIL_RE.test(email)) fields.email = "Enter your email address.";
  if (!input.name?.trim()) fields.name = "Enter your name.";
  const problem = passwordProblem(input.password ?? "", email);
  if (problem) fields.password = problem;
  if (Object.keys(fields).length) throw new ValidationError("Check the form.", fields);
  if (!opts.viaInvitation && !(await signupOpen())) throw new ForbiddenError("Sign-up on this server is by invitation. Ask an administrator for an invitation link.");
  const passwordHash = await hashPassword(input.password);
  return withTransaction(async (tx) => {
    if (await findUserByEmail(tx, email)) throw new ConflictError("An account with that email already exists. Sign in instead.", "email_taken");
    const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(users);
    const [u] = await tx
      .insert(users)
      .values({ email, name: input.name.trim(), passwordHash, isInstanceAdmin: (count?.n ?? 0) === 0 })
      .returning();
    await auditInstance(tx, { action: "user.signed_up", actorUserId: u!.id, actorLabel: email, entityType: "user", entityId: u!.id, ip: opts.ip ?? null });
    return u!;
  });
}

// ── Throttling ──────────────────────────────────────────────────────────────

const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 8;
const LOCK_MS = 15 * 60_000;

async function checkThrottle(key: string) {
  const [row] = await getDb().select().from(authThrottle).where(eq(authThrottle.key, key));
  if (row?.lockedUntil && row.lockedUntil > new Date()) throw new RateLimitError();
}

async function recordFailure(key: string) {
  const now = new Date();
  await getDb().execute(sql`
    insert into auth_throttle (key, failures, window_started_at) values (${key}, 1, ${now})
    on conflict (key) do update set
      failures = case when auth_throttle.window_started_at < ${new Date(now.getTime() - WINDOW_MS)} then 1 else auth_throttle.failures + 1 end,
      window_started_at = case when auth_throttle.window_started_at < ${new Date(now.getTime() - WINDOW_MS)} then ${now} else auth_throttle.window_started_at end,
      locked_until = case when (case when auth_throttle.window_started_at < ${new Date(now.getTime() - WINDOW_MS)} then 1 else auth_throttle.failures + 1 end) >= ${MAX_FAILURES}
        then ${new Date(now.getTime() + LOCK_MS)} else auth_throttle.locked_until end
  `);
}

async function clearThrottle(key: string) {
  await getDb().delete(authThrottle).where(eq(authThrottle.key, key));
}

// ── Sessions ────────────────────────────────────────────────────────────────

export async function createSession(userId: string, opts: { ip?: string | null; userAgent?: string | null; pendingMfa?: boolean } = {}): Promise<{ token: string; session: Session }> {
  const token = randomToken(32);
  const [session] = await getDb()
    .insert(sessions)
    .values({
      userId,
      tokenHash: sha256Hex(token),
      pendingMfa: opts.pendingMfa ?? false,
      expiresAt: new Date(Date.now() + (opts.pendingMfa ? 10 * 60_000 : SESSION_DAYS * 86_400_000)),
      ip: opts.ip ?? null,
      userAgent: opts.userAgent?.slice(0, 300) ?? null,
    })
    .returning();
  return { token, session: session! };
}

/** The session and user for a cookie token, extending the session as it is used. */
export async function sessionFromToken(token: string | undefined | null): Promise<{ session: Session; user: User } | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  const db = getDb();
  const [row] = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, sha256Hex(token)), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())));
  if (!row || row.user.disabledAt) return null;
  // Slide the expiry at most once an hour.
  if (!row.session.pendingMfa && Date.now() - row.session.lastSeenAt.getTime() > 3_600_000) {
    await db
      .update(sessions)
      .set({ lastSeenAt: new Date(), expiresAt: new Date(Date.now() + SESSION_DAYS * 86_400_000) })
      .where(eq(sessions.id, row.session.id));
  }
  return row;
}

export async function revokeSession(token: string) {
  await getDb().update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.tokenHash, sha256Hex(token)));
}

export async function revokeAllSessions(userId: string, exceptSessionId?: string) {
  await getDb()
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), exceptSessionId ? sql`${sessions.id} <> ${exceptSessionId}` : sql`true`));
}

export async function listSessions(userId: string) {
  return getDb()
    .select()
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date()), eq(sessions.pendingMfa, false)))
    .orderBy(desc(sessions.lastSeenAt));
}

/**
 * Check an email and password. Returns the user and whether a second factor
 * is still needed. Failures are throttled per account and per address.
 */
export async function authenticate(email: string, password: string, ip?: string | null): Promise<{ user: User; needsMfa: boolean }> {
  const e = normalizeEmail(email ?? "");
  const keys = [`email:${e}`, ...(ip ? [`ip:${ip}`] : [])];
  for (const k of keys) await checkThrottle(k);
  const user = await findUserByEmail(getDb(), e);
  const ok = await verifyPassword(password ?? "", user?.passwordHash);
  if (!user || !ok || user.disabledAt) {
    for (const k of keys) await recordFailure(k);
    await auditInstance(getDb(), { action: "user.sign_in_failed", actorLabel: e, ip: ip ?? null, metadata: { exists: !!user } });
    throw new UnauthorizedError("That email and password do not match an account.");
  }
  await clearThrottle(`email:${e}`);
  return { user, needsMfa: !!user.totpEnabledAt };
}

/** Finish a sign-in that is waiting for a second factor. */
export async function completeMfa(sessionToken: string, code: string, ip?: string | null): Promise<{ token: string; user: User }> {
  const db = getDb();
  const [row] = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, sha256Hex(sessionToken)), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date()), eq(sessions.pendingMfa, true)));
  if (!row) throw new UnauthorizedError("That sign-in has expired. Start again.");
  const key = `mfa:${row.user.id}`;
  await checkThrottle(key);
  if (!row.user.totpSecretEnc || !verifyTotp(decryptSecret(row.user.totpSecretEnc), code)) {
    await recordFailure(key);
    throw new UnauthorizedError("That code is not right. Use the current code from your authenticator app.");
  }
  await clearThrottle(key);
  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, row.session.id));
  const fresh = await createSession(row.user.id, { ip: ip ?? null, userAgent: row.session.userAgent });
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, row.user.id));
  await auditInstance(db, { action: "user.signed_in", actorUserId: row.user.id, actorLabel: row.user.email, ip: ip ?? null, metadata: { mfa: true } });
  return { token: fresh.token, user: row.user };
}

export async function noteSignedIn(user: User, ip?: string | null) {
  await getDb().update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  await auditInstance(getDb(), { action: "user.signed_in", actorUserId: user.id, actorLabel: user.email, ip: ip ?? null, metadata: { mfa: false } });
}

// ── Two-step verification ───────────────────────────────────────────────────

export async function beginTotpEnrollment(userId: string): Promise<string> {
  const secret = newTotpSecret();
  await getDb().update(users).set({ totpSecretEnc: encryptSecret(secret), totpEnabledAt: null }).where(eq(users.id, userId));
  return secret;
}

export async function confirmTotpEnrollment(userId: string, code: string) {
  const db = getDb();
  const user = await getUser(db, userId);
  if (!user.totpSecretEnc) throw new ConflictError("Start two-step setup first.", "no_secret");
  if (!verifyTotp(decryptSecret(user.totpSecretEnc), code)) throw new ValidationError("That code is not right. Check the time on your phone and try the current code.", { code: "Wrong code." });
  await db.update(users).set({ totpEnabledAt: new Date() }).where(eq(users.id, userId));
  await auditInstance(db, { action: "user.mfa_enabled", actorUserId: userId, actorLabel: user.email });
}

export async function disableTotp(userId: string, password: string) {
  const db = getDb();
  const user = await getUser(db, userId);
  if (!(await verifyPassword(password, user.passwordHash))) throw new ValidationError("That password is not right.", { password: "Wrong password." });
  await db.update(users).set({ totpEnabledAt: null, totpSecretEnc: null }).where(eq(users.id, userId));
  await auditInstance(db, { action: "user.mfa_disabled", actorUserId: userId, actorLabel: user.email });
}

// ── Passwords ───────────────────────────────────────────────────────────────

export async function changePassword(userId: string, current: string, next: string, keepSessionId?: string) {
  const db = getDb();
  const user = await getUser(db, userId);
  if (!(await verifyPassword(current, user.passwordHash))) throw new ValidationError("Your current password is not right.", { current: "Wrong password." });
  const problem = passwordProblem(next, user.email);
  if (problem) throw new ValidationError(problem, { password: problem });
  await db.update(users).set({ passwordHash: await hashPassword(next), updatedAt: new Date() }).where(eq(users.id, userId));
  await revokeAllSessions(userId, keepSessionId);
  await auditInstance(db, { action: "user.password_changed", actorUserId: userId, actorLabel: user.email });
}

/** Create a reset token (returned so the caller can email the link). Unknown emails get null, silently. */
export async function createPasswordReset(email: string): Promise<{ user: User; token: string } | null> {
  const db = getDb();
  const user = await findUserByEmail(db, email);
  if (!user || user.disabledAt) return null;
  const token = randomToken(32);
  await db.insert(userTokens).values({ userId: user.id, purpose: "password_reset", tokenHash: sha256Hex(token), expiresAt: new Date(Date.now() + 60 * 60_000) });
  await auditInstance(db, { action: "user.password_reset_requested", actorUserId: user.id, actorLabel: user.email });
  return { user, token };
}

export async function resetPassword(token: string, next: string) {
  return withTransaction(async (tx) => {
    const [t] = await tx
      .select()
      .from(userTokens)
      .where(and(eq(userTokens.tokenHash, sha256Hex(token)), eq(userTokens.purpose, "password_reset"), isNull(userTokens.usedAt), gt(userTokens.expiresAt, new Date())))
      .for("update");
    if (!t) throw new ValidationError("That reset link has expired or was already used. Ask for a new one.");
    const user = await getUser(tx, t.userId);
    const problem = passwordProblem(next, user.email);
    if (problem) throw new ValidationError(problem, { password: problem });
    await tx.update(users).set({ passwordHash: await hashPassword(next), updatedAt: new Date() }).where(eq(users.id, user.id));
    await tx.update(userTokens).set({ usedAt: new Date() }).where(eq(userTokens.id, t.id));
    await tx.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, user.id), isNull(sessions.revokedAt)));
    await auditInstance(tx, { action: "user.password_reset", actorUserId: user.id, actorLabel: user.email });
    return user;
  });
}

// ── Members and invitations ─────────────────────────────────────────────────

export async function listMembers(db: DbOrTx, orgId: string) {
  return db
    .select({ userId: users.id, email: users.email, name: users.name, role: memberships.role, joinedAt: memberships.createdAt, mfa: users.totpEnabledAt })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.orgId, orgId))
    .orderBy(users.name);
}

export async function listInvitations(db: DbOrTx, orgId: string) {
  return db
    .select()
    .from(invitations)
    .where(and(eq(invitations.orgId, orgId), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, new Date())))
    .orderBy(desc(invitations.createdAt));
}

/** Invite someone by email. Returns the token for the link (sent by the caller). */
export async function inviteMember(ctx: Ctx, email: string, role: Role): Promise<{ token: string; invitationId: string }> {
  requirePermission(ctx, "members.manage");
  const e = normalizeEmail(email);
  if (!EMAIL_RE.test(e)) throw new ValidationError("Enter an email address.", { email: "Invalid." });
  if (!canGrantRole(ctx.role, role)) throw new ForbiddenError("You cannot invite someone with a role above your own.");
  const token = randomToken(32);
  const row = await withTransaction(async (tx) => {
    const existing = await findUserByEmail(tx, e);
    if (existing) {
      const [m] = await tx.select().from(memberships).where(and(eq(memberships.orgId, ctx.orgId), eq(memberships.userId, existing.id)));
      if (m) throw new ConflictError(`${e} is already a member.`, "already_member");
    }
    const [inv] = await tx
      .insert(invitations)
      .values({ orgId: ctx.orgId, email: e, role, tokenHash: sha256Hex(token), expiresAt: new Date(Date.now() + 7 * 86_400_000), createdBy: ctx.actor.userId })
      .returning();
    await audit(tx, ctx, { action: "member.invited", entityType: "invitation", entityId: inv!.id, metadata: { email: e, role } });
    return inv!;
  });
  return { token, invitationId: row.id };
}

export async function invitationByToken(token: string) {
  const [row] = await getDb()
    .select({ invitation: invitations, org: organizations })
    .from(invitations)
    .innerJoin(organizations, eq(organizations.id, invitations.orgId))
    .where(and(eq(invitations.tokenHash, sha256Hex(token)), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, new Date())));
  return row ?? null;
}

export async function acceptInvitation(token: string, userId: string) {
  return withTransaction(async (tx) => {
    const [inv] = await tx
      .select()
      .from(invitations)
      .where(and(eq(invitations.tokenHash, sha256Hex(token)), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, new Date())))
      .for("update");
    if (!inv) throw new ValidationError("That invitation has expired or was already used.");
    const user = await getUser(tx, userId);
    if (normalizeEmail(user.email) !== inv.email) throw new ForbiddenError(`This invitation is for ${inv.email}. Sign in with that address.`);
    await tx.insert(memberships).values({ orgId: inv.orgId, userId, role: inv.role, invitedBy: inv.createdBy }).onConflictDoNothing();
    await tx.update(invitations).set({ acceptedAt: new Date() }).where(eq(invitations.id, inv.id));
    const [org] = await tx.select().from(organizations).where(eq(organizations.id, inv.orgId));
    await audit(tx, { org: org!, orgId: inv.orgId, role: inv.role, actor: { type: "user", userId, label: user.email }, source: "ui", requestId: crypto.randomUUID() }, {
      action: "member.joined",
      entityType: "membership",
      entityId: userId,
      metadata: { role: inv.role },
    });
    return org!;
  });
}

export async function revokeInvitation(ctx: Ctx, invitationId: string) {
  requirePermission(ctx, "members.manage");
  await withTransaction(async (tx) => {
    await tx.update(invitations).set({ revokedAt: new Date() }).where(and(eq(invitations.orgId, ctx.orgId), eq(invitations.id, invitationId)));
    await audit(tx, ctx, { action: "member.invitation_revoked", entityType: "invitation", entityId: invitationId });
  });
}

export async function changeMemberRole(ctx: Ctx, userId: string, role: Role) {
  requirePermission(ctx, "members.manage");
  await withTransaction(async (tx) => {
    const [m] = await tx.select().from(memberships).where(and(eq(memberships.orgId, ctx.orgId), eq(memberships.userId, userId))).for("update");
    if (!m) throw new NotFoundError("The member");
    if (!canGrantRole(ctx.role, role) || ROLE_RANK[m.role] > ROLE_RANK[ctx.role]) throw new ForbiddenError("You cannot change a role above your own.");
    if (m.role === "owner" && role !== "owner") {
      const [owners] = await tx.select({ n: sql<number>`count(*)::int` }).from(memberships).where(and(eq(memberships.orgId, ctx.orgId), eq(memberships.role, "owner")));
      if ((owners?.n ?? 0) <= 1) throw new ConflictError("An organization needs at least one owner.", "last_owner");
    }
    await tx.update(memberships).set({ role }).where(and(eq(memberships.orgId, ctx.orgId), eq(memberships.userId, userId)));
    await audit(tx, ctx, { action: "member.role_changed", entityType: "membership", entityId: userId, before: { role: m.role }, after: { role } });
  });
}

export async function removeMember(ctx: Ctx, userId: string) {
  requirePermission(ctx, "members.manage");
  await withTransaction(async (tx) => {
    const [m] = await tx.select().from(memberships).where(and(eq(memberships.orgId, ctx.orgId), eq(memberships.userId, userId))).for("update");
    if (!m) throw new NotFoundError("The member");
    if (ROLE_RANK[m.role] > ROLE_RANK[ctx.role]) throw new ForbiddenError("You cannot remove someone with a role above your own.");
    if (m.role === "owner") {
      const [owners] = await tx.select({ n: sql<number>`count(*)::int` }).from(memberships).where(and(eq(memberships.orgId, ctx.orgId), eq(memberships.role, "owner")));
      if ((owners?.n ?? 0) <= 1) throw new ConflictError("An organization needs at least one owner.", "last_owner");
    }
    await tx.delete(memberships).where(and(eq(memberships.orgId, ctx.orgId), eq(memberships.userId, userId)));
    await tx.update(apiTokens).set({ revokedAt: new Date() }).where(and(eq(apiTokens.orgId, ctx.orgId), eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)));
    await audit(tx, ctx, { action: "member.removed", entityType: "membership", entityId: userId, before: { role: m.role } });
  });
}

// ── API tokens ──────────────────────────────────────────────────────────────

export const API_TOKEN_PREFIX = "gbk_";

export async function createApiToken(ctx: Ctx, input: { name: string; role: Role; expiresInDays?: number | null }): Promise<{ token: string; id: string }> {
  requirePermission(ctx, "api_tokens.manage");
  if (!input.name?.trim()) throw new ValidationError("Name the token after what will use it.", { name: "Required." });
  if (ROLE_RANK[input.role] > ROLE_RANK[ctx.role] || input.role === "owner") throw new ForbiddenError("A token's role cannot be above yours, and cannot be owner.");
  const token = API_TOKEN_PREFIX + randomToken(30);
  return withTransaction(async (tx) => {
    const [row] = await tx
      .insert(apiTokens)
      .values({
        orgId: ctx.orgId,
        userId: ctx.actor.userId!,
        name: input.name.trim(),
        prefix: token.slice(0, 10),
        tokenHash: sha256Hex(token),
        role: input.role,
        expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null,
      })
      .returning();
    await audit(tx, ctx, { action: "api_token.created", entityType: "api_token", entityId: row!.id, metadata: { name: row!.name, role: row!.role } });
    return { token, id: row!.id };
  });
}

export async function listApiTokens(db: DbOrTx, orgId: string) {
  return db
    .select({ token: apiTokens, userEmail: users.email })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(and(eq(apiTokens.orgId, orgId), isNull(apiTokens.revokedAt)))
    .orderBy(desc(apiTokens.createdAt));
}

export async function revokeApiToken(ctx: Ctx, id: string) {
  requirePermission(ctx, "api_tokens.manage");
  await withTransaction(async (tx) => {
    await tx.update(apiTokens).set({ revokedAt: new Date() }).where(and(eq(apiTokens.orgId, ctx.orgId), eq(apiTokens.id, id)));
    await audit(tx, ctx, { action: "api_token.revoked", entityType: "api_token", entityId: id });
  });
}

/** Resolve a bearer token to its organization, user and effective role. */
export async function resolveApiToken(token: string) {
  if (!token.startsWith(API_TOKEN_PREFIX)) return null;
  const db = getDb();
  const [row] = await db
    .select({ token: apiTokens, user: users, membership: memberships, org: organizations })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .innerJoin(memberships, and(eq(memberships.orgId, apiTokens.orgId), eq(memberships.userId, apiTokens.userId)))
    .innerJoin(organizations, eq(organizations.id, apiTokens.orgId))
    .where(and(eq(apiTokens.tokenHash, sha256Hex(token)), isNull(apiTokens.revokedAt)));
  if (!row || row.user.disabledAt) return null;
  if (row.token.expiresAt && row.token.expiresAt < new Date()) return null;
  // The token never exceeds the person's current role.
  const role = ROLE_RANK[row.token.role] <= ROLE_RANK[row.membership.role] ? row.token.role : row.membership.role;
  if (!row.token.lastUsedAt || Date.now() - row.token.lastUsedAt.getTime() > 60_000) {
    await db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, row.token.id));
  }
  return { token: row.token, user: row.user, org: row.org, role };
}

export async function updateUserName(userId: string, name: string) {
  if (!name?.trim() || name.length > 120) throw new ValidationError("Enter your name.", { name: "Required (up to 120 characters)." });
  const db = getDb();
  await db.update(users).set({ name: name.trim(), updatedAt: new Date() }).where(eq(users.id, userId));
  const user = await getUser(db, userId);
  await auditInstance(db, { action: "user.profile_updated", actorUserId: userId, actorLabel: user.email });
}

export async function revokeSessionById(userId: string, sessionId: string) {
  await getDb().update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, userId), eq(sessions.id, sessionId)));
}
