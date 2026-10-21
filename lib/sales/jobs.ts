/**
 * Background job handlers for the sales module (registered in lib/jobs/handlers.ts):
 *
 *  sales.recurring          — make every due recurring-invoice occurrence
 *                             (payload: { orgId?, today? }); idempotent.
 *  payments.process_event   — the accounting for one recorded payment-provider
 *                             webhook event (payload: { eventRowId }); idempotent.
 */
import { z } from "zod";
import type { JobHandler } from "@/lib/jobs/queue";
import { runDueRecurring } from "./recurring";
import { processWebhookEvent } from "@/lib/integrations/payments/process";

const recurringPayload = z.object({ orgId: z.string().uuid().optional(), today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
const eventPayload = z.object({ eventRowId: z.string().uuid() });

export const salesJobs: Record<string, JobHandler> = {
  "sales.recurring": async (job) => {
    const p = recurringPayload.parse(job.payload ?? {});
    return runDueRecurring(p.today, p.orgId ?? job.orgId ?? undefined);
  },
  "payments.process_event": async (job) => {
    const { eventRowId } = eventPayload.parse(job.payload);
    return processWebhookEvent(eventRowId);
  },
};
