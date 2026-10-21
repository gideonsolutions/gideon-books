/** Background job handlers for the taxexport module (registered in lib/jobs/handlers.ts). */
import type { JobHandler } from "@/lib/jobs/queue";

export const taxexportJobs: Record<string, JobHandler> = {};
