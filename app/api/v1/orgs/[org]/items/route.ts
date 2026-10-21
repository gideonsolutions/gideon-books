import { getDb } from "@/lib/db/client";
import { apiHandler, paged, pagination } from "@/lib/api/route";
import { ItemBody } from "@/lib/api/schemas";
import { createItem, listItems } from "@/lib/items/items";

export const GET = apiHandler({
  permission: "org.read",
  handler: async ({ ctx, query }) => {
    const { page, pageSize } = pagination(query);
    const r = await listItems(getDb(), ctx.orgId, { q: query.get("q") ?? undefined, kind: (query.get("kind") as "service" | "non_stock" | "stock" | null) ?? undefined, includeArchived: query.get("archived") === "1", page, pageSize });
    return paged(r.rows, r.total, page, pageSize);
  },
});

export const POST = apiHandler({
  permission: "items.manage",
  body: ItemBody,
  status: 201,
  handler: async ({ ctx, body }) => ({ data: await createItem(ctx, body) }),
});
