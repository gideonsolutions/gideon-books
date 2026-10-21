/** Background job handlers for the fixed-assets module (registered in lib/jobs/handlers.ts). */
import { z } from "zod";
import type { JobHandler } from "@/lib/jobs/queue";
import { runMonthlyDepreciation } from "./depreciation";

const payload = z.object({ orgId: z.string().uuid(), periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

export const assetsJobs: Record<string, JobHandler> = {
  /** Prepare (and, only if the organization opted in, post) the monthly depreciation run. */
  "assets.depreciate": async (job) => {
    const p = payload.parse(job.payload);
    return runMonthlyDepreciation(p.orgId, p.periodEnd);
  },
};
