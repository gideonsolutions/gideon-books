import { getDb } from "@/lib/db/client";
import { apiHandler } from "@/lib/api/route";
import { ContactBody } from "@/lib/api/schemas";
import { getContact, getContactPersons, updateContact } from "@/lib/contacts/contacts";

export const GET = apiHandler({
  permission: "org.read",
  handler: async ({ ctx, params }) => ({ data: { ...(await getContact(getDb(), ctx.orgId, params.id!)), persons: await getContactPersons(getDb(), ctx.orgId, params.id!) } }),
});

export const PATCH = apiHandler({
  permission: "contacts.manage",
  body: ContactBody,
  handler: async ({ ctx, params, body }) => ({ data: await updateContact(ctx, params.id!, body) }),
});
