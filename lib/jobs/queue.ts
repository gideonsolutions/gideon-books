/**
 * Durable background jobs in Postgres. Enqueueing is idempotent by
 * `dedupeKey`; a worker claims a due job with FOR UPDATE SKIP LOCKED, runs
 * its handler, and records the result. A failure is retried with exponential
 * backoff (30 s × 2^attempt, capped at 6 h) until max_attempts, then marked
 * dead and shown on the jobs page. A job stuck in "running" (its worker
 * died) is reclaimed after JOB_STALE_SECONDS.
 *
 * Handlers must be idempotent: a job may run again after a crash between
 * its effect and its completion. They achieve it with idempotency keys on
 * what they post.
 */
import { and, desc, eq, lte, sql, inArray } from "drizzle-orm";
import { getDb, type DbOrTx } from "@/lib/db/client";
import { jobs } from "@/lib/db/schema/core";
import { log } from "@/lib/log";

export type Job = typeof jobs.$inferSelect;

export interface EnqueueOptions {
  orgId?: string | null;
  runAt?: Date;
  dedupeKey?: string | null;
  maxAttempts?: number;
  createdBy?: string | null;
}

export async function enqueue(db: DbOrTx, kind: string, payload: Record<string, unknown>, opts: EnqueueOptions = {}): Promise<Job> {
  const values = {
    kind,
    payload,
    orgId: opts.orgId ?? null,
    runAt: opts.runAt ?? new Date(),
    dedupeKey: opts.dedupeKey ?? null,
    maxAttempts: opts.maxAttempts ?? 5,
    createdBy: opts.createdBy ?? null,
  };
  if (opts.dedupeKey) {
    const [row] = await db.insert(jobs).values(values).onConflictDoNothing({ target: jobs.dedupeKey }).returning();
    if (row) return row;
    const [existing] = await db.select().from(jobs).where(eq(jobs.dedupeKey, opts.dedupeKey));
    return existing!;
  }
  const [row] = await db.insert(jobs).values(values).returning();
  return row!;
}

export type JobHandler = (job: Job, helpers: { progress: (p: Record<string, unknown>) => Promise<void> }) => Promise<unknown>;

const STALE_SECONDS = Number(process.env.JOB_STALE_SECONDS ?? 900);

/** Claim the next due job (or null). */
export async function claim(workerId: string, kinds?: string[]): Promise<Job | null> {
  const db = getDb();
  const res = await db.execute<{ id: string }>(sql`
    update jobs set status = 'running', locked_by = ${workerId}, locked_at = now(), attempts = attempts + 1
    where id = (
      select id from jobs
      where (
        (status in ('queued', 'failed') and run_at <= now())
        or (status = 'running' and locked_at < now() - make_interval(secs => ${STALE_SECONDS}))
      )
      ${kinds?.length ? sql`and kind in (${sql.join(kinds.map((k) => sql`${k}`), sql`, `)})` : sql``}
      order by run_at
      limit 1
      for update skip locked
    )
    returning id
  `);
  const id = res.rows[0]?.id;
  if (!id) return null;
  const [job] = await db.select().from(jobs).where(eq(jobs.id, id));
  return job ?? null;
}

export function backoffMs(attempt: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 6 * 3_600_000);
}

export async function runJob(job: Job, handlers: Record<string, JobHandler>): Promise<"succeeded" | "failed" | "dead"> {
  const db = getDb();
  const handler = handlers[job.kind];
  const started = Date.now();
  try {
    if (!handler) throw new Error(`no handler for job kind ${job.kind}`);
    const result = await handler(job, {
      progress: async (p) => {
        await db.update(jobs).set({ progress: p }).where(eq(jobs.id, job.id));
      },
    });
    await db
      .update(jobs)
      .set({ status: "succeeded", result: (result ?? null) as never, finishedAt: new Date(), lockedBy: null, lastError: null })
      .where(eq(jobs.id, job.id));
    log.info("job succeeded", { jobId: job.id, kind: job.kind, orgId: job.orgId, ms: Date.now() - started });
    return "succeeded";
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    const dead = job.attempts >= job.maxAttempts;
    await db
      .update(jobs)
      .set({
        status: dead ? "dead" : "failed",
        lastError: message.slice(0, 2000),
        runAt: new Date(Date.now() + backoffMs(job.attempts)),
        lockedBy: null,
        finishedAt: dead ? new Date() : null,
      })
      .where(eq(jobs.id, job.id));
    log.warn("job failed", { jobId: job.id, kind: job.kind, orgId: job.orgId, attempt: job.attempts, dead, error: message });
    return dead ? "dead" : "failed";
  }
}

/** Run due jobs until none are left (or `max`). Used by the worker loop and by tests. */
export async function drain(handlers: Record<string, JobHandler>, opts: { workerId?: string; max?: number; kinds?: string[] } = {}): Promise<number> {
  const workerId = opts.workerId ?? `inline-${process.pid}`;
  let n = 0;
  while (n < (opts.max ?? 1000)) {
    const job = await claim(workerId, opts.kinds);
    if (!job) break;
    await runJob(job, handlers);
    n++;
  }
  return n;
}

export async function listJobs(db: DbOrTx, orgId: string, opts: { status?: string; limit?: number } = {}) {
  const conds = [eq(jobs.orgId, orgId)];
  if (opts.status) conds.push(eq(jobs.status, opts.status as never));
  return db.select().from(jobs).where(and(...conds)).orderBy(desc(jobs.createdAt)).limit(opts.limit ?? 100);
}

export async function getJob(db: DbOrTx, orgId: string, id: string) {
  const [j] = await db.select().from(jobs).where(and(eq(jobs.orgId, orgId), eq(jobs.id, id)));
  return j ?? null;
}

/** Retry a failed or dead job now. */
export async function retryJob(db: DbOrTx, orgId: string, id: string) {
  await db
    .update(jobs)
    .set({ status: "queued", runAt: new Date(), maxAttempts: sql`greatest(${jobs.maxAttempts}, ${jobs.attempts} + 1)` })
    .where(and(eq(jobs.orgId, orgId), eq(jobs.id, id), inArray(jobs.status, ["failed", "dead", "cancelled"])));
}

export async function cancelJob(db: DbOrTx, orgId: string, id: string) {
  await db
    .update(jobs)
    .set({ status: "cancelled", finishedAt: new Date() })
    .where(and(eq(jobs.orgId, orgId), eq(jobs.id, id), inArray(jobs.status, ["queued", "failed"])));
}

/** Health: jobs waiting longer than they should. */
export async function queueHealth() {
  const db = getDb();
  const [r] = await db
    .select({
      queued: sql<number>`count(*) filter (where status in ('queued','failed') and run_at <= now())::int`,
      oldestDueSeconds: sql<number | null>`extract(epoch from now() - min(run_at) filter (where status in ('queued','failed') and run_at <= now()))::int`,
      dead: sql<number>`count(*) filter (where status = 'dead' and finished_at > now() - interval '1 day')::int`,
    })
    .from(jobs)
    .where(lte(jobs.createdAt, new Date()));
  return r!;
}
