/** Background job handlers for the consolidation module (registered in lib/jobs/handlers.ts). */
import type { JobHandler } from "@/lib/jobs/queue";

export const consolidationJobs: Record<string, JobHandler> = {};
