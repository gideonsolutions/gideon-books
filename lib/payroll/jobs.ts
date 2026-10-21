/**
 * Background job handlers for the payroll module (registered in
 * lib/jobs/handlers.ts). Payroll imports are interactive (upload, preview,
 * post), so the module has no scheduled work.
 */
import type { JobHandler } from "@/lib/jobs/queue";

export const payrollJobs: Record<string, JobHandler> = {};
