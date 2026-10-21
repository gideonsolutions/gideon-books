import { getDb } from "@/lib/db/client";
import { apiHandler } from "@/lib/api/route";
import { AccountBody } from "@/lib/api/schemas";
import { createAccount, listAccounts } from "@/lib/ledger/accounts";

/** GET: the chart of accounts. ?archived=1 includes archived accounts. */
export const GET = apiHandler({
  permission: "ledger.read",
  handler: async ({ ctx, query }) => ({ data: await listAccounts(getDb(), ctx.orgId, { includeArchived: query.get("archived") === "1" }) }),
});

/** POST: create an account. */
export const POST = apiHandler({
  permission: "accounts.manage",
  body: AccountBody,
  status: 201,
  handler: async ({ ctx, body }) => ({ data: await createAccount(ctx, body) }),
});
