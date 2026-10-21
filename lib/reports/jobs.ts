/** Background job handlers for the reports module (registered in lib/jobs/handlers.ts). */
import type { JobHandler } from "@/lib/jobs/queue";

export const reportsJobs: Record<string, JobHandler> = {};
