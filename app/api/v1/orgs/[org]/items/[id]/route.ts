import { getDb } from "@/lib/db/client";
import { apiHandler } from "@/lib/api/route";
import { ItemBody } from "@/lib/api/schemas";
import { getItem, updateItem } from "@/lib/items/items";

export const GET = apiHandler({
  permission: "org.read",
  handler: async ({ ctx, params }) => ({ data: await getItem(getDb(), ctx.orgId, params.id!) }),
});

export const PATCH = apiHandler({
  permission: "items.manage",
  body: ItemBody,
  handler: async ({ ctx, params, body }) => ({ data: await updateItem(ctx, params.id!, body) }),
});
