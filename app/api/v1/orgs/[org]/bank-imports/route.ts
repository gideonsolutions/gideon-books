import { getDb } from "@/lib/db/client";
import { apiHandler } from "@/lib/api/route";
import { commitImport, listImportBatches, previewImport } from "@/lib/banking/imports";
import { detectDelimiter, guessMapping, parseCsv } from "@/lib/banking/csv";
import type { CsvMappingConfig } from "@/lib/db/schema/banking";
import { BankImportBody } from "@/lib/api/schemas";

/** GET: import batches. */
export const GET = apiHandler({
  permission: "banking.read",
  handler: async ({ ctx, query }) => ({ data: await listImportBatches(getDb(), ctx.orgId, { accountId: query.get("account_id") ?? undefined, limit: 200 }) }),
});

/**
 * POST: import a bank statement CSV into a money account (or preview it).
 * Duplicate rows (already imported) are skipped unless listed in
 * includeDuplicateRows; importing never posts to the ledger.
 */
export const POST = apiHandler({
  permission: "banking.import",
  body: BankImportBody,
  idempotent: true,
  status: 201,
  handler: async ({ ctx, body }) => {
    const mapping: CsvMappingConfig = body.mapping ?? guessMapping(parseCsv(body.text), detectDelimiter(body.text));
    if (body.preview) return { data: await previewImport(getDb(), ctx, { accountId: body.accountId, text: body.text, mapping }) };
    const batch = await commitImport(ctx, { accountId: body.accountId, fileName: body.fileName, text: body.text, mapping, includeDuplicateRows: body.includeDuplicateRows ?? [] });
    return { data: batch };
  },
});
