import { getDb } from "@/lib/db/client";
import { apiHandler, paged, pagination } from "@/lib/api/route";
import { JournalEntryBody } from "@/lib/api/schemas";
import { listEntries, postManualEntry } from "@/lib/ledger/journals";

/** GET: journal entries, newest first. Filters: from, to, status, kind, q, account_id. */
export const GET = apiHandler({
  permission: "ledger.read",
  handler: async ({ ctx, query }) => {
    const { page, pageSize } = pagination(query);
    const r = await listEntries(getDb(), ctx.orgId, {
      from: query.get("from") ?? undefined,
      to: query.get("to") ?? undefined,
      status: (query.get("status") as "draft" | "posted" | null) ?? undefined,
      kind: query.get("kind") ?? undefined,
      q: query.get("q") ?? undefined,
      accountId: query.get("account_id") ?? undefined,
      page,
      pageSize,
    });
    return paged(r.rows.map((x) => ({ ...x.entry, total: x.total, reversedByNumber: x.reversedBy })), r.total, page, pageSize);
  },
});

/** POST: post a manual journal entry. Send an Idempotency-Key header to make retries safe. */
export const POST = apiHandler({
  permission: "ledger.post",
  body: JournalEntryBody,
  idempotent: true,
  status: 201,
  handler: async ({ ctx, body, idempotencyKey }) => {
    const r = await postManualEntry(ctx, body, { idempotencyKey });
    return { data: { ...r.entry, lines: r.lines } };
  },
});
