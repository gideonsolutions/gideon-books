/** Background job handlers for the banking module (registered in lib/jobs/handlers.ts). */
import { z } from "zod";
import type { JobHandler } from "@/lib/jobs/queue";
import { systemCtx } from "@/lib/context";
import { syncAllFeeds, syncConnection } from "./feeds/sync";

const payload = z.object({ orgId: z.string().uuid().optional(), connectionId: z.string().uuid().optional() });

export const bankingJobs: Record<string, JobHandler> = {
  /**
   * Sync bank feeds: one connection ({ orgId, connectionId }) or every active
   * feed of every organization ({}). The scheduler enqueues the latter daily.
   */
  "banking.feed_sync": async (job) => {
    const p = payload.parse(job.payload ?? {});
    if (p.orgId && p.connectionId) {
      const ctx = await systemCtx(p.orgId, "job: bank feed sync");
      return syncConnection(ctx, p.connectionId);
    }
    return syncAllFeeds();
  },
};

export { syncAllFeeds };
