/**
 * Server actions return a result the form can show: success with optional
 * data, or a message and per-field errors. Unexpected errors are logged and
 * shown as a plain apology with a reference, never their internals.
 */
import { randomUUID } from "node:crypto";
import { unstable_rethrow } from "next/navigation";
import { isAppError, type FieldErrors } from "@/lib/errors";
import { log } from "@/lib/log";
import { pgErrorMessage } from "@/lib/db/client";

export type ActionResult<T = undefined> =
  | { ok: true; data?: T; message?: string }
  | { ok: false; error: string; fields?: FieldErrors; code?: string };

export async function runAction<T>(fn: () => Promise<T>, success?: string): Promise<ActionResult<T>> {
  try {
    const data = await fn();
    return { ok: true, ...(data !== undefined ? { data } : {}), ...(success ? { message: success } : {}) };
  } catch (err) {
    // Redirects and not-found are how Next.js navigates; let them through.
    unstable_rethrow(err);
    if (isAppError(err)) return { ok: false, error: err.message, code: err.code, ...(err.fields ? { fields: err.fields } : {}) };
    const dbMsg = pgErrorMessage(err);
    if (dbMsg && /immutable|cannot|closed|locked|balance|append-only|permanent/.test(dbMsg)) {
      return { ok: false, error: `The database refused this: ${dbMsg}.`, code: "refused" };
    }
    const ref = randomUUID().slice(0, 8);
    log.error("server action failed", { ref, error: (err as Error)?.message, stack: (err as Error)?.stack });
    return { ok: false, error: `Something went wrong on our side (reference ${ref}). Nothing was saved.`, code: "internal" };
  }
}

/** Read a FormData value as a trimmed string (empty → null). */
export function str(fd: FormData, key: string): string | null {
  const v = fd.get(key);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

export function bool(fd: FormData, key: string): boolean {
  const v = fd.get(key);
  return v === "on" || v === "true" || v === "1";
}
