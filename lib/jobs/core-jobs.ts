/** Core job handlers: email delivery, exchange-rate fetching, automatic reversals. */
import { z } from "zod";
import type { JobHandler } from "./queue";
import { deliverEmail } from "@/lib/email/send";
import { runAutoReversals } from "@/lib/fx/revaluation";
import { fetchRates } from "@/lib/fx/providers";
import { systemCtx } from "@/lib/context";
import { addDays, todayIn } from "@/lib/dates";

const emailPayload = z.object({ messageId: z.string().uuid() });
const orgPayload = z.object({ orgId: z.string().uuid() });

export const coreJobs: Record<string, JobHandler> = {
  "email.send": async (job) => {
    const { messageId } = emailPayload.parse(job.payload);
    return deliverEmail(messageId);
  },
  "ledger.auto_reverse": async (job) => {
    const { orgId } = orgPayload.parse(job.payload);
    return runAutoReversals(orgId);
  },
  "fx.fetch_rates": async (job) => {
    const p = orgPayload.extend({ from: z.string().optional(), to: z.string().optional() }).parse(job.payload);
    const ctx = await systemCtx(p.orgId, "job: fetch exchange rates");
    const to = p.to ?? todayIn(ctx.org.timezone);
    return fetchRates(ctx, { from: p.from ?? addDays(to, -10), to });
  },
};
