import { getDb } from "@/lib/db/client";
import { apiHandler, paged, pagination } from "@/lib/api/route";
import { DocumentBody } from "@/lib/api/schemas";
import { getDocument, issueDocument, listDocuments, saveDraft } from "@/lib/commerce/documents";
import { requirePermission } from "@/lib/context";
import type { DocumentKind } from "@/lib/db/schema/commerce";

/** GET: documents. Filters: kind (comma-separated), status (or "open"), contact_id, from, to, q, overdue=1. */
export const GET = apiHandler({
  permission: "org.read",
  handler: async ({ ctx, query }) => {
    const { page, pageSize } = pagination(query);
    const kind = query.get("kind")?.split(",").filter(Boolean) as DocumentKind[] | undefined;
    const r = await listDocuments(getDb(), ctx.orgId, {
      ...(kind?.length ? { kind } : {}),
      status: query.get("status") ?? undefined,
      contactId: query.get("contact_id") ?? undefined,
      from: query.get("from") ?? undefined,
      to: query.get("to") ?? undefined,
      q: query.get("q") ?? undefined,
      overdue: query.get("overdue") === "1",
      page,
      pageSize,
    });
    return paged(r.rows.map((x) => ({ ...x.doc, contactName: x.contactName, openAmount: x.openAmount })), r.total, page, pageSize);
  },
});

/** POST: create a draft document; with "issue": true it is issued (posted) in the same call. */
export const POST = apiHandler({
  permission: "org.read",
  body: DocumentBody,
  idempotent: true,
  status: 201,
  handler: async ({ ctx, body, idempotencyKey }) => {
    requirePermission(ctx, ["estimate", "invoice", "credit_note", "write_off", "sales_receipt"].includes(body.kind) ? "sales.manage" : "purchases.manage");
    const { issue, ...input } = body;
    const draft = await saveDraft(ctx, input);
    const doc = issue ? await issueDocument(ctx, draft.id, { idempotencyKey }) : draft;
    const full = await getDocument(getDb(), ctx.orgId, doc.id);
    return { data: { ...full.doc, lines: full.lines, taxes: full.taxes } };
  },
});
