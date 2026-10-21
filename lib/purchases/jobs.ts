/** Background job handlers for the purchases module (registered in lib/jobs/handlers.ts). */
import { z } from "zod";
import type { JobHandler } from "@/lib/jobs/queue";
import { runDueRecurringBills, runTemplate } from "./recurring";

const payload = z.object({ orgId: z.string().uuid().optional(), templateId: z.string().uuid().optional(), today: z.string().optional() });

export const purchasesJobs: Record<string, JobHandler> = {
  /**
   * Produce due recurring bills. With `templateId`, just that schedule ("run
   * now"); otherwise every due schedule (of `orgId`, or all organizations).
   */
  "purchases.recurring": async (job) => {
    const p = payload.parse(job.payload);
    if (p.templateId) return runTemplate(p.templateId, p.today);
    return runDueRecurringBills(p.today, p.orgId);
  },
};
