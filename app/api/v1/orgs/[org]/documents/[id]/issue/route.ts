import { apiHandler } from "@/lib/api/route";
import { issueDocument } from "@/lib/commerce/documents";

/** POST: issue (post) a draft document. Idempotent with an Idempotency-Key. */
export const POST = apiHandler({
  permission: "org.read",
  idempotent: true,
  handler: async ({ ctx, params, idempotencyKey }) => ({ data: await issueDocument(ctx, params.id!, { idempotencyKey }) }),
});
