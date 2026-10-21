/**
 * Every job kind and its handler. Each module keeps its handlers in its own
 * jobs.ts; this is the one place they are put together.
 */
import type { JobHandler } from "./queue";
import { coreJobs } from "./core-jobs";
import { salesJobs } from "@/lib/sales/jobs";
import { purchasesJobs } from "@/lib/purchases/jobs";
import { bankingJobs } from "@/lib/banking/jobs";
import { assetsJobs } from "@/lib/assets/jobs";
import { payrollJobs } from "@/lib/payroll/jobs";
import { reportsJobs } from "@/lib/reports/jobs";
import { opsJobs } from "@/lib/ops/jobs";
import { hostedJobs } from "@/lib/hosted/jobs";
import { consolidationJobs } from "@/lib/consolidation/jobs";
import { projectsJobs } from "@/lib/projects/jobs";
import { taxexportJobs } from "@/lib/taxexport/jobs";

export const HANDLERS: Record<string, JobHandler> = {
  ...coreJobs,
  ...salesJobs,
  ...purchasesJobs,
  ...bankingJobs,
  ...assetsJobs,
  ...payrollJobs,
  ...reportsJobs,
  ...opsJobs,
  ...hostedJobs,
  ...consolidationJobs,
  ...projectsJobs,
  ...taxexportJobs,
};

/** Human names for job kinds, for the jobs page. */
export const JOB_LABELS: Record<string, string> = {
  "email.send": "Send email",
  "fx.fetch_rates": "Fetch exchange rates",
  "ledger.auto_reverse": "Reverse accruals and revaluations",
  "schedule.daily": "Daily maintenance",
};
