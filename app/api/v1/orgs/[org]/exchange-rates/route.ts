import { getDb } from "@/lib/db/client";
import { apiHandler } from "@/lib/api/route";
import { ExchangeRateBody } from "@/lib/api/schemas";
import { addManualRate, listRates } from "@/lib/fx/rates";

export const GET = apiHandler({
  permission: "ledger.read",
  handler: async ({ ctx, query }) => ({ data: await listRates(getDb(), ctx.orgId, { currency: query.get("currency") ?? undefined, limit: 500 }) }),
});

export const POST = apiHandler({
  permission: "fx.manage",
  body: ExchangeRateBody,
  status: 201,
  handler: async ({ ctx, body }) => ({ data: await addManualRate(ctx, body) }),
});
