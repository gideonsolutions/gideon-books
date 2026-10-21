import { getDb } from "@/lib/db/client";
import { apiHandler, paged, pagination } from "@/lib/api/route";
import { PaymentBody } from "@/lib/api/schemas";
import { listPayments, recordPayment } from "@/lib/commerce/payments";
import type { PaymentKind } from "@/lib/db/schema/commerce";

/** GET: payments. Filters: kind, side (customer|vendor), contact_id, account_id, from, to, q, unapplied=1. */
export const GET = apiHandler({
  permission: "org.read",
  handler: async ({ ctx, query }) => {
    const { page, pageSize } = pagination(query);
    const r = await listPayments(getDb(), ctx.orgId, {
      ...(query.get("kind") ? { kind: query.get("kind") as PaymentKind } : {}),
      side: (query.get("side") as "customer" | "vendor" | null) ?? undefined,
      contactId: query.get("contact_id") ?? undefined,
      accountId: query.get("account_id") ?? undefined,
      from: query.get("from") ?? undefined,
      to: query.get("to") ?? undefined,
      q: query.get("q") ?? undefined,
      unapplied: query.get("unapplied") === "1",
      page,
      pageSize,
    });
    return paged(r.rows.map((x) => ({ ...x.payment, contactName: x.contactName, accountName: x.accountName, unapplied: x.unapplied })), r.total, page, pageSize);
  },
});

/** POST: record a payment and apply it. Recording never moves money. Idempotent with an Idempotency-Key. */
export const POST = apiHandler({
  permission: "payments.record",
  body: PaymentBody,
  idempotent: true,
  status: 201,
  handler: async ({ ctx, body, idempotencyKey }) => ({ data: await recordPayment(ctx, body, { idempotencyKey }) }),
});
