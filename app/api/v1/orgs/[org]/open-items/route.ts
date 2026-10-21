import { getDb } from "@/lib/db/client";
import { apiHandler } from "@/lib/api/route";
import { openItemsForContact } from "@/lib/commerce/open-items";
import { ValidationError } from "@/lib/errors";

/** GET: a contact's open receivable or payable items (?contact_id=…&side=receivables|payables&as_of=…). */
export const GET = apiHandler({
  permission: "ledger.read",
  handler: async ({ ctx, query }) => {
    const contactId = query.get("contact_id");
    const side = query.get("side");
    if (!contactId || (side !== "receivables" && side !== "payables")) throw new ValidationError("Give contact_id and side=receivables|payables.");
    return { data: await openItemsForContact(getDb(), ctx.orgId, side, contactId, query.get("as_of") ?? undefined) };
  },
});
