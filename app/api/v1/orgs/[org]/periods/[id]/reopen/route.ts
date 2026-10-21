import { apiHandler } from "@/lib/api/route";
import { PeriodReopenBody } from "@/lib/api/schemas";
import { reopenPeriod } from "@/lib/ledger/periods";

export const POST = apiHandler({
  permission: "periods.reopen",
  body: PeriodReopenBody,
  handler: async ({ ctx, params, body }) => ({ data: await reopenPeriod(ctx, params.id!, body.reason) }),
});
