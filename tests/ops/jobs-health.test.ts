import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { jobs } from "@/lib/db/schema/core";
import { backoffMs, claim, enqueue, retryJob, runJob, drain } from "@/lib/jobs/queue";
import { ensureDailySchedule, runDailySchedule } from "@/lib/jobs/schedule";
import { liveness, readiness } from "@/lib/ops/health";
import { setupOrg } from "../helpers";

describe("job queue", () => {
  it("retries with growing backoff, then marks a job dead; a person can retry it", async () => {
    const o = await setupOrg();
    const job = await enqueue(getDb(), "test.always_fails", {}, { orgId: o.orgId, maxAttempts: 3 });
    const handlers = { "test.always_fails": async () => Promise.reject(new Error("provider down")) };
    for (let i = 1; i <= 3; i++) {
      await getDb().update(jobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(jobs.id, job.id));
      const claimed = await claim("w1", ["test.always_fails"]);
      expect(claimed?.id).toBe(job.id);
      const status = await runJob(claimed!, handlers);
      expect(status).toBe(i < 3 ? "failed" : "dead");
      const [row] = await getDb().select().from(jobs).where(eq(jobs.id, job.id));
      expect(row!.attempts).toBe(i);
      expect(row!.lastError).toBe("provider down");
      if (i < 3) expect(row!.runAt.getTime()).toBeGreaterThan(Date.now() + backoffMs(i) - 5000);
    }
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(60_000);
    expect(backoffMs(30)).toBe(6 * 3_600_000);
    await retryJob(getDb(), o.orgId, job.id);
    const ok = await drain({ "test.always_fails": async () => ({ fine: true }) }, { kinds: ["test.always_fails"] });
    expect(ok).toBe(1);
    const [done] = await getDb().select().from(jobs).where(eq(jobs.id, job.id));
    expect(done!.status).toBe("succeeded");
  });

  it("enqueues idempotently by dedupe key, and two workers never run one job twice", async () => {
    const a = await enqueue(getDb(), "test.once", {}, { dedupeKey: "test.once:1" });
    const b = await enqueue(getDb(), "test.once", {}, { dedupeKey: "test.once:1" });
    expect(b.id).toBe(a.id);
    const [c1, c2] = await Promise.all([claim("w1", ["test.once"]), claim("w2", ["test.once"])]);
    expect([c1, c2].filter(Boolean)).toHaveLength(1);
  });

  it("schedules each day's work once per organization, however often it runs", async () => {
    const o = await setupOrg();
    const now = new Date("2026-06-10T08:00:00Z");
    const first = await ensureDailySchedule(now);
    const second = await ensureDailySchedule(now);
    expect(second.id).toBe(first.id);
    await runDailySchedule("2026-06-10");
    await runDailySchedule("2026-06-10");
    const r = await getDb().execute<{ n: number }>(sql`select count(*)::int as n from jobs where kind = 'ledger.auto_reverse' and org_id = ${o.orgId}`);
    expect(r.rows[0]!.n).toBe(1);
  });
});

describe("health", () => {
  it("reports liveness and readiness without secrets", async () => {
    expect(liveness().status).toBe("ok");
    const r = await readiness();
    expect(r.checks.database!.ok).toBe(true);
    expect(r.checks.storage!.ok).toBe(true);
    expect(r.checks.jobs!.ok).toBe(true);
    if ((process.env.TEST_SCHEMA_SOURCE ?? "migrations") === "migrations") expect(r.checks.migrations!.ok).toBe(true);
    else expect(r.checks.migrations!.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(process.env.DATABASE_URL!);
    expect(JSON.stringify(r)).not.toContain(process.env.BOOKS_ENCRYPTION_KEY!);
  });
});
