"use server";

import { getDb } from "@/lib/db/client";
import { audit } from "@/lib/audit";
import { requirePermission } from "@/lib/context";
import { cancelJob, retryJob } from "@/lib/jobs/queue";
import { runAction, type ActionResult } from "@/lib/web/actions";
import { orgCtx } from "@/lib/web/session";

export async function retryJobAction(slug: string, id: string): Promise<ActionResult<unknown>> {
  return runAction(async () => {
    const ctx = await orgCtx(slug);
    requirePermission(ctx, "org.settings");
    await retryJob(getDb(), ctx.orgId, id);
    await audit(getDb(), ctx, { action: "job.retried", entityType: "job", entityId: id });
  }, "Queued to run again.");
}

export async function cancelJobAction(slug: string, id: string): Promise<ActionResult<unknown>> {
  return runAction(async () => {
    const ctx = await orgCtx(slug);
    requirePermission(ctx, "org.settings");
    await cancelJob(getDb(), ctx.orgId, id);
    await audit(getDb(), ctx, { action: "job.cancelled", entityType: "job", entityId: id });
  }, "Cancelled.");
}
