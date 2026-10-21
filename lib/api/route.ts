/**
 * The REST API's request handling: authentication (an API token, or the
 * browser session with a same-origin check), the organization in the path,
 * permission, input validation, idempotency keys, pagination, and errors as
 * JSON with stable codes. Route files under app/api/v1 are thin wrappers
 * around service functions through `apiHandler`.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { z, ZodError, type ZodType } from "zod";
import { getDb, pgErrorMessage } from "@/lib/db/client";
import { idempotencyKeys } from "@/lib/db/schema/core";
import { resolveApiToken, sessionFromToken } from "@/lib/auth/users";
import { membershipFor, orgBySlug } from "@/lib/orgs/orgs";
import { requirePermission, type Ctx } from "@/lib/context";
import type { Permission } from "@/lib/authz/permissions";
import { AppError, ConflictError, ForbiddenError, NotFoundError, UnauthorizedError, ValidationError, isAppError } from "@/lib/errors";
import { log } from "@/lib/log";

export const SESSION_COOKIE = "gb_session";

export interface ApiArgs<B> {
  ctx: Ctx;
  req: NextRequest;
  params: Record<string, string>;
  query: URLSearchParams;
  body: B;
  idempotencyKey: string | null;
}

export interface ApiSpec<B> {
  permission: Permission | Permission[];
  body?: ZodType<B>;
  /** Honor an Idempotency-Key header (POST endpoints that create or post things). */
  idempotent?: boolean;
  status?: number;
  handler: (args: ApiArgs<B>) => Promise<unknown>;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}

export function errorResponse(err: unknown, requestId: string): Response {
  if (isAppError(err)) return json(err.status, { ...err.toJSON(), request_id: requestId });
  if (err instanceof ZodError) {
    const fields: Record<string, string> = {};
    for (const issue of err.issues) fields[issue.path.join(".") || "_"] = issue.message;
    return json(422, { error: { code: "validation_failed", message: "The request body is not valid.", fields }, request_id: requestId });
  }
  const dbMsg = pgErrorMessage(err);
  if (dbMsg && /immutable|cannot|closed|locked|balance|append-only|permanent/.test(dbMsg)) {
    return json(409, { error: { code: "refused_by_database", message: dbMsg }, request_id: requestId });
  }
  log.error("api error", { requestId, error: (err as Error)?.message, stack: (err as Error)?.stack });
  return json(500, { error: { code: "internal_error", message: "Something went wrong on our side. Nothing was saved." }, request_id: requestId });
}

function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const allowed = new Set([new URL(req.url).origin]);
  if (process.env.APP_URL) allowed.add(new URL(process.env.APP_URL).origin);
  return allowed.has(origin);
}

/** Resolve who is calling and for which organization. */
export async function authenticateApi(req: NextRequest, orgParam: string, requestId: string): Promise<Ctx> {
  const auth = req.headers.get("authorization");
  const db = getDb();
  if (auth?.toLowerCase().startsWith("bearer ")) {
    const resolved = await resolveApiToken(auth.slice(7).trim());
    if (!resolved) throw new UnauthorizedError("The API token is missing, expired or revoked.");
    if (resolved.org.slug !== orgParam && resolved.org.id !== orgParam) throw new ForbiddenError("That token is for a different organization.");
    return {
      org: resolved.org,
      orgId: resolved.org.id,
      role: resolved.role,
      actor: { type: "api_token", userId: resolved.user.id, label: `API token “${resolved.token.name}” (${resolved.user.email})`, tokenId: resolved.token.id },
      source: "api",
      requestId,
      ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    };
  }
  const session = await sessionFromToken(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session || session.session.pendingMfa) throw new UnauthorizedError("Send an API token as `Authorization: Bearer gbk_…`.");
  if (!["GET", "HEAD"].includes(req.method) && !sameOrigin(req)) throw new ForbiddenError("Cross-site request refused.");
  const org = await orgBySlug(db, orgParam);
  if (!org) throw new NotFoundError("The organization");
  const role = await membershipFor(db, org.id, session.user.id);
  if (!role) throw new NotFoundError("The organization");
  return {
    org,
    orgId: org.id,
    role,
    actor: { type: "user", userId: session.user.id, label: session.user.email },
    source: "api",
    requestId,
    ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
  };
}

async function readBody(req: NextRequest): Promise<{ raw: string; parsed: unknown }> {
  const raw = await req.text();
  if (raw.length > 5_000_000) throw new ValidationError("The request body is larger than 5 MB.");
  if (!raw) return { raw, parsed: {} };
  try {
    return { raw, parsed: JSON.parse(raw) };
  } catch {
    throw new ValidationError("The request body is not valid JSON.");
  }
}

export function apiHandler<B = unknown>(spec: ApiSpec<B>) {
  return async (req: NextRequest, context: { params: Promise<Record<string, string>> }): Promise<Response> => {
    const requestId = req.headers.get("x-request-id")?.slice(0, 64) || randomUUID();
    const started = Date.now();
    let ctx: Ctx | null = null;
    try {
      const params = await context.params;
      ctx = await authenticateApi(req, params.org ?? "", requestId);
      const perms = Array.isArray(spec.permission) ? spec.permission : [spec.permission];
      requirePermission(ctx, ...perms);
      const query = new URL(req.url).searchParams;
      let body: B = undefined as B;
      let raw = "";
      if (spec.body) {
        const r = await readBody(req);
        raw = r.raw;
        body = spec.body.parse(r.parsed);
      }
      const key = spec.idempotent ? req.headers.get("idempotency-key")?.trim() || null : null;
      if (key && (key.length < 8 || key.length > 200)) throw new ValidationError("Idempotency-Key must be 8–200 characters.");

      if (key) {
        const scope = `${req.method} ${new URL(req.url).pathname}`;
        const hash = createHash("sha256").update(raw).digest("hex");
        const db = getDb();
        const inserted = await db
          .insert(idempotencyKeys)
          .values({ orgId: ctx.orgId, scope, key, requestHash: hash, status: "in_progress" })
          .onConflictDoNothing()
          .returning();
        if (!inserted.length) {
          const [prior] = await db
            .select()
            .from(idempotencyKeys)
            .where(and(eq(idempotencyKeys.orgId, ctx.orgId), eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)));
          if (prior && prior.requestHash !== hash) throw new ConflictError("That Idempotency-Key was used with a different request body.", "idempotency_key_reused");
          if (prior?.status === "completed") {
            return json(prior.responseStatus ?? 200, prior.responseBody, { "idempotent-replayed": "true", "x-request-id": requestId });
          }
          throw new ConflictError("A request with that Idempotency-Key is still being processed.", "idempotency_in_progress");
        }
        try {
          const result = await spec.handler({ ctx, req, params, query, body, idempotencyKey: key });
          const status = spec.status ?? 200;
          await db
            .update(idempotencyKeys)
            .set({ status: "completed", responseStatus: status, responseBody: result as never, completedAt: new Date() })
            .where(and(eq(idempotencyKeys.orgId, ctx.orgId), eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)));
          return json(status, result, { "x-request-id": requestId });
        } catch (err) {
          // A failed request does not burn the key: the client may retry it.
          await db.delete(idempotencyKeys).where(and(eq(idempotencyKeys.orgId, ctx.orgId), eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)));
          throw err;
        }
      }

      const result = await spec.handler({ ctx, req, params, query, body, idempotencyKey: null });
      if (result instanceof Response) return result;
      return json(spec.status ?? 200, result, { "x-request-id": requestId });
    } catch (err) {
      if (!(err instanceof AppError) && !(err instanceof ZodError)) {
        log.warn("api request failed", { requestId, path: req.nextUrl.pathname, method: req.method, orgId: ctx?.orgId, ms: Date.now() - started });
      }
      return errorResponse(err, requestId);
    }
  };
}

/** Page and page size from the query (?page=1&page_size=50, max 500). */
export function pagination(query: URLSearchParams): { page: number; pageSize: number } {
  const page = Math.max(1, Number.parseInt(query.get("page") ?? "1", 10) || 1);
  const pageSize = Math.min(500, Math.max(1, Number.parseInt(query.get("page_size") ?? "50", 10) || 50));
  return { page, pageSize };
}

export function paged<T>(rows: T[], total: number, page: number, pageSize: number) {
  return { data: rows, page, page_size: pageSize, total, has_more: page * pageSize < total };
}

/** Common request schemas. */
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");
export const zDecimal = z.string().regex(/^-?\d+(\.\d+)?$/, "Use a decimal string, e.g. \"12.50\".");
export const zUuid = z.string().uuid();
