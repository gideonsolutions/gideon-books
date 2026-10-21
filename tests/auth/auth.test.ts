import { describe, expect, it } from "vitest";
import { hashPassword, passwordProblem, verifyPassword } from "@/lib/auth/password";
import { base32Decode, base32Encode, totpCode, verifyTotp } from "@/lib/auth/totp";
import {
  acceptInvitation,
  authenticate,
  beginTotpEnrollment,
  changeMemberRole,
  completeMfa,
  confirmTotpEnrollment,
  createApiToken,
  createSession,
  inviteMember,
  removeMember,
  resolveApiToken,
  sessionFromToken,
} from "@/lib/auth/users";
import { ROLE_PERMISSIONS, canGrantRole } from "@/lib/authz/permissions";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secrets";
import { newUser, rejectsWith, setupOrg } from "../helpers";
import { getDb } from "@/lib/db/client";
import { eq } from "drizzle-orm";
import { users } from "@/lib/db/schema/core";

describe("passwords and secrets", () => {
  it("hashes with scrypt and verifies in constant time", async () => {
    const h = await hashPassword("correct horse battery staple");
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse battery staple", h)).toBe(true);
    expect(await verifyPassword("wrong horse battery staple", h)).toBe(false);
    expect(passwordProblem("short")).toMatch(/10 characters/);
    expect(passwordProblem("password1234")).toMatch(/guess/);
  });

  it("encrypts secrets at rest", () => {
    const enc = encryptSecret("sk_live_secret");
    expect(enc).not.toContain("sk_live");
    expect(decryptSecret(enc)).toBe("sk_live_secret");
  });

  it("computes RFC 6238 codes", () => {
    // RFC 6238 test vector: secret "12345678901234567890" (SHA-1), T = 59 → 94287082 (8 digits) → last 6: 287082
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    expect(totpCode(secret, 59_000)).toBe("287082");
    expect(base32Decode(secret).toString()).toBe("12345678901234567890");
    expect(verifyTotp(secret, "287082", 59_000)).toBe(true);
    expect(verifyTotp(secret, "000000", 59_000)).toBe(false);
  });
});

describe("sign-in", () => {
  it("throttles repeated failures and requires the second factor when enabled", async () => {
    const u = await newUser();
    for (let i = 0; i < 8; i++) await authenticate(u.email, "nope nope nope", "10.0.0.9").catch(() => {});
    await rejectsWith(authenticate(u.email, "correct horse battery staple", "10.0.0.9"), "rate_limited");

    const v = await newUser();
    const secret = await beginTotpEnrollment(v.id);
    await confirmTotpEnrollment(v.id, totpCode(secret));
    const r = await authenticate(v.email, "correct horse battery staple");
    expect(r.needsMfa).toBe(true);
    const pending = await createSession(v.id, { pendingMfa: true });
    expect(await sessionFromToken(pending.token)).toBeTruthy();
    await rejectsWith(completeMfa(pending.token, "000000"), "unauthorized");
    const done = await completeMfa(pending.token, totpCode(secret));
    const s = await sessionFromToken(done.token);
    expect(s?.session.pendingMfa).toBe(false);
  });

  it("refuses a disabled user", async () => {
    const u = await newUser();
    await getDb().update(users).set({ disabledAt: new Date() }).where(eq(users.id, u.id));
    await rejectsWith(authenticate(u.email, "correct horse battery staple"), "unauthorized");
  });
});

describe("roles and membership", () => {
  it("grants by role as documented", () => {
    expect(ROLE_PERMISSIONS.read_only.has("ledger.post")).toBe(false);
    expect(ROLE_PERMISSIONS.staff.has("ledger.post")).toBe(false);
    expect(ROLE_PERMISSIONS.staff.has("sales.issue")).toBe(true);
    expect(ROLE_PERMISSIONS.accountant.has("periods.reopen")).toBe(true);
    expect(ROLE_PERMISSIONS.accountant.has("members.manage")).toBe(false);
    expect(ROLE_PERMISSIONS.admin.has("billing.manage")).toBe(false);
    expect(ROLE_PERMISSIONS.owner.has("org.delete")).toBe(true);
    expect(canGrantRole("admin", "owner")).toBe(false);
    expect(canGrantRole("owner", "owner")).toBe(true);
  });

  it("invites with a role no higher than the inviter's, and keeps one owner", async () => {
    const o = await setupOrg();
    const admin = await o.as("admin");
    await rejectsWith(inviteMember(admin, "boss@example.test", "owner"), "forbidden");
    const invitee = await newUser("Invited Accountant");
    const { token } = await inviteMember(admin, invitee.email, "accountant");
    const org = await acceptInvitation(token, invitee.id);
    expect(org.id).toBe(o.orgId);
    await rejectsWith(changeMemberRole(o.ctx, o.userId, "admin"), "last_owner");
    await rejectsWith(removeMember(admin, o.userId), "forbidden");
  });

  it("caps an API token at its creator's current role", async () => {
    const o = await setupOrg();
    const accountant = await o.as("accountant");
    await rejectsWith(createApiToken(accountant, { name: "x", role: "admin" }), "forbidden");
    const t = await createApiToken(o.ctx, { name: "integration", role: "admin" });
    const r = await resolveApiToken(t.token);
    expect(r?.role).toBe("admin");
    expect(await resolveApiToken(t.token + "x")).toBeNull();
  });
});
