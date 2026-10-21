/**
 * The background worker (`npm run worker`): claims due jobs and runs them,
 * WORKER_CONCURRENCY at a time (default 2), and keeps the daily schedule
 * enqueued. On SIGTERM/SIGINT it stops claiming, lets running jobs finish
 * (up to WORKER_SHUTDOWN_SECONDS, default 60), and exits. Any number of
 * workers may run against one database.
 */
import os from "node:os";
import { claim, runJob } from "../lib/jobs/queue";
import { HANDLERS } from "../lib/jobs/handlers";
import { ensureDailySchedule } from "../lib/jobs/schedule";
import { closeDb } from "../lib/db/client";
import { log } from "../lib/log";

const concurrency = Math.max(1, Number(process.env.WORKER_CONCURRENCY ?? 2));
const idleMs = Math.max(200, Number(process.env.WORKER_IDLE_MS ?? 1000));
const workerId = `${os.hostname()}:${process.pid}`;
let stopping = false;
const running = new Set<Promise<unknown>>();

async function slot(n: number) {
  while (!stopping) {
    let job;
    try {
      job = await claim(`${workerId}#${n}`);
    } catch (e) {
      log.error("worker could not claim a job", { error: (e as Error).message });
      await new Promise((r) => setTimeout(r, idleMs * 5));
      continue;
    }
    if (!job) {
      await new Promise((r) => setTimeout(r, idleMs));
      continue;
    }
    const p = runJob(job, HANDLERS);
    running.add(p);
    await p.finally(() => running.delete(p));
  }
}

async function scheduler() {
  while (!stopping) {
    try {
      await ensureDailySchedule();
    } catch (e) {
      log.error("scheduler failed", { error: (e as Error).message });
    }
    for (let i = 0; i < 60 && !stopping; i++) await new Promise((r) => setTimeout(r, 1000));
  }
}

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info("worker stopping", { signal, running: running.size });
  const deadline = Number(process.env.WORKER_SHUTDOWN_SECONDS ?? 60) * 1000;
  await Promise.race([Promise.allSettled([...running]), new Promise((r) => setTimeout(r, deadline))]);
  await closeDb().catch(() => {});
  log.info("worker stopped");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

log.info("worker started", { workerId, concurrency, kinds: Object.keys(HANDLERS).length });
void scheduler();
for (let i = 0; i < concurrency; i++) void slot(i);
