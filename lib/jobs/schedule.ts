/**
 * The scheduler: once a day (per UTC date) it enqueues each organization's
 * periodic work. Every job carries a dedupe key with the date, so any number
 * of workers running the scheduler at once produce each job exactly once.
 *
 * Daily, per organization: automatic reversals (accruals, revaluations);
 * exchange-rate fetching where the organization uses foreign currencies;
 * recurring invoices and bills; bank-feed syncs; preparing the month's
 * depreciation run for review.
 */
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { enqueue } from "./queue";

export function utcDate(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Enqueue the daily maintenance job for `now`'s date (idempotent). */
export async function ensureDailySchedule(now = new Date()) {
  const day = utcDate(now);
  return enqueue(getDb(), "schedule.daily", { day }, { dedupeKey: `schedule.daily:${day}`, maxAttempts: 3 });
}

/** The daily job: fan out per-organization work with per-day dedupe keys. */
export async function runDailySchedule(day: string): Promise<{ enqueued: number }> {
  const db = getDb();
  const orgs = await db.execute<{ id: string; base_currency: string; foreign: boolean }>(sql`
    select o.id, o.base_currency,
      exists (
        select 1 from journal_lines l where l.org_id = o.id and l.currency <> o.base_currency
        union all select 1 from contacts c where c.org_id = o.id and c.currency is not null and c.currency <> o.base_currency
        union all select 1 from accounts a where a.org_id = o.id and a.currency is not null and a.currency <> o.base_currency
      ) as foreign
    from organizations o where o.archived_at is null
  `);
  let enqueued = 0;
  for (const o of orgs.rows) {
    await enqueue(db, "ledger.auto_reverse", { orgId: o.id }, { orgId: o.id, dedupeKey: `ledger.auto_reverse:${o.id}:${day}` });
    enqueued++;
    if (o.foreign && (process.env.FX_PROVIDER ?? "ecb") !== "none") {
      await enqueue(db, "fx.fetch_rates", { orgId: o.id }, { orgId: o.id, dedupeKey: `fx.fetch_rates:${o.id}:${day}`, maxAttempts: 3 });
      enqueued++;
    }
  }
  for (const kind of ["schedule.recurring_invoices", "schedule.recurring_bills", "schedule.bank_feeds", "schedule.depreciation"]) {
    await enqueue(db, kind, { day }, { dedupeKey: `${kind}:${day}`, maxAttempts: 3 });
    enqueued++;
  }
  return { enqueued };
}
