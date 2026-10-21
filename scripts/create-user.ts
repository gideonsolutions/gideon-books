/**
 * Administer accounts from the server's shell — no email needed.
 *
 *   npm run admin:create-user -- --email a@b.c --name "A Person" [--admin]   (prompts for a password, or reads BOOKS_NEW_PASSWORD)
 *   npm run admin:create-user -- --reset a@b.c                             (sets a new password, signs out everywhere)
 *   npm run admin:create-user -- --disable a@b.c | --enable a@b.c
 */
import { stdin, stdout } from "node:process";
import readline from "node:readline/promises";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "../lib/db/client";
import { users, sessions } from "../lib/db/schema/core";
import { createUser, findUserByEmail } from "../lib/auth/users";
import { hashPassword, passwordProblem } from "../lib/auth/password";
import { auditInstance } from "../lib/audit";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function askPassword(email: string): Promise<string> {
  if (process.env.BOOKS_NEW_PASSWORD) return process.env.BOOKS_NEW_PASSWORD;
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
  const p = await rl.question(`New password for ${email} (10+ characters): `);
  rl.close();
  return p;
}

async function main() {
  const db = getDb();
  const reset = arg("reset");
  const disable = arg("disable");
  const enable = arg("enable");
  if (reset) {
    const user = await findUserByEmail(db, reset);
    if (!user) throw new Error(`no account for ${reset}`);
    const password = await askPassword(user.email);
    const problem = passwordProblem(password, user.email);
    if (problem) throw new Error(problem);
    await db.update(users).set({ passwordHash: await hashPassword(password), updatedAt: new Date() }).where(eq(users.id, user.id));
    await db.update(sessions).set({ revokedAt: new Date() }).where(sql`${sessions.userId} = ${user.id} and ${sessions.revokedAt} is null`);
    await auditInstance(db, { action: "user.password_reset_by_admin", actorLabel: "cli", entityType: "user", entityId: user.id, source: "cli" });
    console.log(`Password reset for ${user.email}; all their sessions were signed out.`);
    return;
  }
  if (disable || enable) {
    const email = (disable ?? enable)!;
    const user = await findUserByEmail(db, email);
    if (!user) throw new Error(`no account for ${email}`);
    await db.update(users).set({ disabledAt: disable ? new Date() : null }).where(eq(users.id, user.id));
    if (disable) await db.update(sessions).set({ revokedAt: new Date() }).where(sql`${sessions.userId} = ${user.id} and ${sessions.revokedAt} is null`);
    await auditInstance(db, { action: disable ? "user.disabled" : "user.enabled", actorLabel: "cli", entityType: "user", entityId: user.id, source: "cli" });
    console.log(`${user.email} ${disable ? "disabled" : "enabled"}.`);
    return;
  }
  const email = arg("email");
  const name = arg("name");
  if (!email || !name) {
    console.error("Usage: --email <email> --name <name> [--admin] | --reset <email> | --disable <email> | --enable <email>");
    process.exit(2);
  }
  const password = await askPassword(email);
  const user = await createUser({ email, name, password }, { viaInvitation: true });
  if (flag("admin") && !user.isInstanceAdmin) await db.update(users).set({ isInstanceAdmin: true }).where(eq(users.id, user.id));
  console.log(`Created ${user.email}${flag("admin") || user.isInstanceAdmin ? " (instance administrator)" : ""}.`);
}

main()
  .then(() => closeDb())
  .catch(async (e) => {
    console.error((e as Error).message);
    await closeDb().catch(() => {});
    process.exit(1);
  });
