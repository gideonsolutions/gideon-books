import { getDb } from "@/lib/db/client";
import { apiHandler } from "@/lib/api/route";
import { AccountBody } from "@/lib/api/schemas";
import { getAccount, updateAccount } from "@/lib/ledger/accounts";
import { accountBalances } from "@/lib/ledger/balances";

export const GET = apiHandler({
  permission: "ledger.read",
  handler: async ({ ctx, params, query }) => {
    const account = await getAccount(getDb(), ctx.orgId, params.id!);
    const asOf = query.get("as_of") ?? undefined;
    const bal = (await accountBalances(getDb(), ctx.orgId, asOf ? { asOf } : {})).get(account.id);
    return { data: { ...account, balance: bal?.base ?? "0", balanceInCurrency: bal?.txn ?? "0" } };
  },
});

export const PATCH = apiHandler({
  permission: "accounts.manage",
  body: AccountBody,
  handler: async ({ ctx, params, body }) => ({ data: await updateAccount(ctx, params.id!, body) }),
});
