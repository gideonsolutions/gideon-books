import { getDb } from "@/lib/db/client";
import { apiHandler } from "@/lib/api/route";
import { getPayment } from "@/lib/commerce/payments";

export const GET = apiHandler({
  permission: "org.read",
  handler: async ({ ctx, params }) => {
    const p = await getPayment(getDb(), ctx.orgId, params.id!);
    return { data: { ...p.payment, applications: p.settlements, unapplied: p.unapplied } };
  },
});
