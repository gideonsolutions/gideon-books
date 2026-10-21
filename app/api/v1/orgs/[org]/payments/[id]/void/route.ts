import { apiHandler } from "@/lib/api/route";
import { VoidBody } from "@/lib/api/schemas";
import { voidPayment } from "@/lib/commerce/payments";
import { todayIn } from "@/lib/dates";

export const POST = apiHandler({
  permission: "payments.void",
  body: VoidBody,
  idempotent: true,
  handler: async ({ ctx, params, body }) => ({ data: await voidPayment(ctx, params.id!, { date: body.date ?? todayIn(ctx.org.timezone), reason: body.reason }) }),
});
