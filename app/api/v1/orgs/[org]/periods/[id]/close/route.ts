import { apiHandler } from "@/lib/api/route";
import { PeriodCloseBody } from "@/lib/api/schemas";
import { closePeriod } from "@/lib/ledger/periods";

export const POST = apiHandler({
  permission: "periods.close",
  body: PeriodCloseBody,
  handler: async ({ ctx, params, body }) => ({ data: await closePeriod(ctx, params.id!, { reason: body.reason ?? null, acknowledgeWarnings: body.acknowledgeWarnings ?? false }) }),
});
