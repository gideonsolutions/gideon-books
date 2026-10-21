/**
 * Health checks. Liveness says the process answers; readiness says it can
 * do its work: the database answers, every migration on disk is applied, the
 * job queue is not backed up, and attachment storage accepts a write. The
 * output names what failed without exposing configuration or secrets.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getPool } from "@/lib/db/client";
import { queueHealth } from "@/lib/jobs/queue";
import { storage } from "@/lib/storage/storage";

export interface CheckResult {
  ok: boolean;
  detail?: string;
  ms?: number;
}

export interface Readiness {
  status: "ready" | "not_ready";
  checks: Record<string, CheckResult>;
}

const started = Date.now();

export function liveness() {
  return { status: "ok", uptimeSeconds: Math.round((Date.now() - started) / 1000) };
}

export function migrationsOnDisk(root = process.cwd()): number {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(root, "lib/db/migrations/meta/_journal.json"), "utf8")) as { entries: unknown[] };
    return j.entries.length;
  } catch {
    return -1;
  }
}

async function timed(fn: () => Promise<CheckResult>): Promise<CheckResult> {
  const t = Date.now();
  try {
    const r = await fn();
    return { ...r, ms: Date.now() - t };
  } catch (e) {
    return { ok: false, detail: (e as Error).message.split("\n")[0]!.slice(0, 200), ms: Date.now() - t };
  }
}

export async function readiness(opts: { maxQueueDelaySeconds?: number } = {}): Promise<Readiness> {
  const maxDelay = opts.maxQueueDelaySeconds ?? Number(process.env.HEALTH_MAX_QUEUE_DELAY_SECONDS ?? 900);
  const checks: Record<string, CheckResult> = {};
  checks.database = await timed(async () => {
    await getPool().query("select 1");
    return { ok: true };
  });
  checks.migrations = await timed(async () => {
    const want = migrationsOnDisk();
    const r = await getPool().query<{ n: number }>(`select count(*)::int as n from drizzle.__drizzle_migrations`);
    const have = r.rows[0]?.n ?? 0;
    if (want < 0) return { ok: false, detail: "migration journal not found" };
    return have >= want ? { ok: true, detail: `${have} applied` } : { ok: false, detail: `${have} of ${want} migrations applied; run the migrate step` };
  });
  checks.jobs = await timed(async () => {
    const q = await queueHealth();
    const delay = q.oldestDueSeconds ?? 0;
    return delay > maxDelay
      ? { ok: false, detail: `${q.queued} jobs waiting, oldest due ${delay}s ago; is the worker running?` }
      : { ok: true, detail: `${q.queued} due, ${q.dead} dead in the last day` };
  });
  checks.storage = await timed(async () => {
    const key = `health/probe-${randomUUID()}`;
    await storage().put(key, Buffer.from("ok"), "text/plain");
    await storage().delete(key);
    return { ok: true, detail: storage().name };
  });
  return { status: Object.values(checks).every((c) => c.ok) ? "ready" : "not_ready", checks };
}
