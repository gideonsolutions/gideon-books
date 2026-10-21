/** Background job handlers for the hosted module (registered in lib/jobs/handlers.ts). */
import type { JobHandler } from "@/lib/jobs/queue";

export const hostedJobs: Record<string, JobHandler> = {};
