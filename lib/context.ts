/**
 * The context every service function runs in: which organization, who is
 * acting (a person, an API token, a job, a webhook), with what role, and
 * from where. Service functions take it as their first argument and check
 * permissions against it on the server.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, type DbOrTx } from "@/lib/db/client";
import { organizations, type Role } from "@/lib/db/schema/core";
import { ROLE_PERMISSIONS, type Permission } from "@/lib/authz/permissions";
import { ForbiddenError, NotFoundError } from "@/lib/errors";

export type Org = typeof organizations.$inferSelect;

export type ActorType = "user" | "api_token" | "system" | "job" | "webhook";
export type Source = "ui" | "api" | "job" | "import" | "webhook" | "system" | "cli";

export interface Actor {
  type: ActorType;
  /** The person behind the action (null for system work). */
  userId: string | null;
  /** How the audit log names the actor: an email, "API token “Zapier”", "job: recurring-invoices". */
  label: string;
  tokenId?: string;
}

export interface Ctx {
  org: Org;
  orgId: string;
  role: Role;
  actor: Actor;
  source: Source;
  requestId: string;
  ip?: string | null;
}

export function can(ctx: Ctx, permission: Permission): boolean {
  return ROLE_PERMISSIONS[ctx.role].has(permission);
}

export function requirePermission(ctx: Ctx, ...permissions: Permission[]): void {
  for (const p of permissions) {
    if (!can(ctx, p)) {
      throw new ForbiddenError(`Your role (${ctx.role.replace("_", "-")}) cannot do this here.`, { permission: p });
    }
  }
}

export async function loadOrg(db: DbOrTx, orgId: string): Promise<Org> {
  const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (!org) throw new NotFoundError("The organization");
  return org;
}

/** Context for background work acting on an organization's behalf. */
export async function systemCtx(orgId: string, label: string, source: Source = "job", db: DbOrTx = getDb()): Promise<Ctx> {
  const org = await loadOrg(db, orgId);
  return {
    org,
    orgId,
    role: "owner",
    actor: { type: source === "webhook" ? "webhook" : source === "job" ? "job" : "system", userId: null, label },
    source,
    requestId: randomUUID(),
  };
}

/** A context for a person acting in the UI or through tests. */
export function userCtx(org: Org, userId: string, role: Role, label: string, source: Source = "ui", ip?: string | null): Ctx {
  return {
    org,
    orgId: org.id,
    role,
    actor: { type: "user", userId, label },
    source,
    requestId: randomUUID(),
    ip: ip ?? null,
  };
}

/** Refresh the organization row (after settings change within a request). */
export async function refreshCtx(ctx: Ctx, db: DbOrTx = getDb()): Promise<Ctx> {
  return { ...ctx, org: await loadOrg(db, ctx.orgId) };
}
