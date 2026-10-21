/** Background job handlers for operations: the daily schedule, data export and import (registered in lib/jobs/handlers.ts). */
import { z } from "zod";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import type { JobHandler } from "@/lib/jobs/queue";
import { enqueue } from "@/lib/jobs/queue";
import { runDailySchedule } from "@/lib/jobs/schedule";
import { runDueRecurring } from "@/lib/sales/recurring";
import { runDueRecurringBills } from "@/lib/purchases/recurring";
import { syncAllFeeds } from "@/lib/banking/feeds/sync";
import { runMonthlyDepreciation } from "@/lib/assets/depreciation";
import { addDays, endOfMonth, startOfMonth } from "@/lib/dates";
import { runExport } from "./export";
import { runImport } from "./import";

const dayPayload = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

export const opsJobs: Record<string, JobHandler> = {
  "schedule.daily": async (job) => {
    const { day } = dayPayload.parse(job.payload);
    return runDailySchedule(day);
  },
  "schedule.recurring_invoices": async (job) => {
    const { day } = dayPayload.parse(job.payload);
    return runDueRecurring(day);
  },
  "schedule.recurring_bills": async (job) => {
    const { day } = dayPayload.parse(job.payload);
    return runDueRecurringBills(day);
  },
  "schedule.bank_feeds": async () => syncAllFeeds(),
  /**
   * In the first days of a month, prepare each organization's depreciation
   * run for the month just ended (for review; posting stays a person's step
   * unless the organization opted into auto-posting).
   */
  "schedule.depreciation": async (job) => {
    const { day } = dayPayload.parse(job.payload);
    if (Number(day.slice(8, 10)) > 3) return { skipped: "not the start of a month" };
    const periodEnd = addDays(startOfMonth(day), -1);
    const orgs = await getDb().execute<{ id: string }>(sql`select id from organizations where archived_at is null`);
    for (const o of orgs.rows) {
      await enqueue(getDb(), "schedule.depreciation_org", { orgId: o.id, periodEnd }, { orgId: o.id, dedupeKey: `schedule.depreciation_org:${o.id}:${periodEnd.slice(0, 7)}` });
    }
    return { orgs: orgs.rows.length, periodEnd };
  },
  "schedule.depreciation_org": async (job) => {
    const p = z.object({ orgId: z.string().uuid(), periodEnd: z.string() }).parse(job.payload);
    if (endOfMonth(p.periodEnd) !== p.periodEnd) throw new Error("periodEnd must be a month end");
    return runMonthlyDepreciation(p.orgId, p.periodEnd);
  },
  "ops.export_org": async (job) => {
    const { exportId } = z.object({ exportId: z.string().uuid() }).parse(job.payload);
    return runExport(exportId);
  },
  "ops.import_org": async (job) => {
    const { importId } = z.object({ importId: z.string().uuid() }).parse(job.payload);
    return runImport(importId);
  },
};

export const OPS_JOB_LABELS: Record<string, string> = {
  "schedule.daily": "Daily maintenance",
  "schedule.recurring_invoices": "Create recurring invoices",
  "schedule.recurring_bills": "Create recurring bills",
  "schedule.bank_feeds": "Sync bank feeds",
  "schedule.depreciation": "Prepare depreciation runs",
  "schedule.depreciation_org": "Prepare depreciation run",
  "ops.export_org": "Export all data",
  "ops.import_org": "Import an organization",
};
