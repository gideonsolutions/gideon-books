import { getDb } from "@/lib/db/client";
import { apiHandler } from "@/lib/api/route";
import { createImport, listImports, postImport, previewImport } from "@/lib/payroll/imports";
import { PayrollImportBody } from "@/lib/api/schemas";

export const GET = apiHandler({
  permission: "ledger.read",
  handler: async ({ ctx }) => ({ data: await listImports(getDb(), ctx.orgId, 100) }),
});

/** POST: upload a payroll run in the documented format; returns the validation preview, and the posted run with "post": true. */
export const POST = apiHandler({
  permission: "payroll.import",
  body: PayrollImportBody,
  idempotent: true,
  status: 201,
  handler: async ({ ctx, body }) => {
    const imp = await createImport(ctx, { adapter: body.adapter, fileName: body.fileName, content: body.content });
    const { preview } = await previewImport(getDb(), ctx, imp.id);
    const run = body.post ? await postImport(ctx, imp.id) : null;
    return { data: { import: imp, preview, run } };
  },
});
