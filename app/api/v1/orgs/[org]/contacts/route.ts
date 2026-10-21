import { getDb } from "@/lib/db/client";
import { apiHandler, paged, pagination } from "@/lib/api/route";
import { ContactBody } from "@/lib/api/schemas";
import { createContact, listContacts } from "@/lib/contacts/contacts";

/** GET: contacts. Filters: role (customer|vendor|employee|beneficiary), q, archived=1. */
export const GET = apiHandler({
  permission: "org.read",
  handler: async ({ ctx, query }) => {
    const { page, pageSize } = pagination(query);
    const r = await listContacts(getDb(), ctx.orgId, {
      role: (query.get("role") as "customer" | "vendor" | "employee" | "beneficiary" | null) ?? undefined,
      q: query.get("q") ?? undefined,
      includeArchived: query.get("archived") === "1",
      page,
      pageSize,
    });
    return paged(r.rows, r.total, page, pageSize);
  },
});

export const POST = apiHandler({
  permission: "contacts.manage",
  body: ContactBody,
  status: 201,
  handler: async ({ ctx, body }) => ({ data: await createContact(ctx, body) }),
});
