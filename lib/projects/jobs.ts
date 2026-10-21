/**
 * Background job handlers for the projects module (registered in
 * lib/jobs/handlers.ts). Billing a project is interactive, so the module has
 * no scheduled work.
 */
import type { JobHandler } from "@/lib/jobs/queue";

export const projectsJobs: Record<string, JobHandler> = {};
