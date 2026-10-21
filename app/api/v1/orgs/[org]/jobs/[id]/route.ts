import { getDb } from "@/lib/db/client";
import { apiHandler } from "@/lib/api/route";
import { getJob } from "@/lib/jobs/queue";
import { NotFoundError } from "@/lib/errors";

export const GET = apiHandler({
  permission: "jobs.read",
  handler: async ({ ctx, params }) => {
    const j = await getJob(getDb(), ctx.orgId, params.id!);
    if (!j) throw new NotFoundError("The job");
    return { data: { id: j.id, kind: j.kind, status: j.status, attempts: j.attempts, lastError: j.lastError, progress: j.progress, result: j.result, createdAt: j.createdAt, finishedAt: j.finishedAt } };
  },
});
