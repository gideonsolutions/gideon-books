import { apiHandler } from "@/lib/api/route";
import { VoidBody } from "@/lib/api/schemas";
import { voidDocument } from "@/lib/commerce/documents";

/** POST: void an issued document (refused while payments or credits are applied). */
export const POST = apiHandler({
  permission: "org.read",
  body: VoidBody,
  idempotent: true,
  handler: async ({ ctx, params, body }) => ({ data: await voidDocument(ctx, params.id!, body) }),
});
