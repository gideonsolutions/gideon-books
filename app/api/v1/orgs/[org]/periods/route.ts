import { getDb } from "@/lib/db/client";
import { apiHandler } from "@/lib/api/route";
import { listFiscalYears } from "@/lib/ledger/periods";

export const GET = apiHandler({
  permission: "ledger.read",
  handler: async ({ ctx }) => ({ data: await listFiscalYears(getDb(), ctx.orgId) }),
});
