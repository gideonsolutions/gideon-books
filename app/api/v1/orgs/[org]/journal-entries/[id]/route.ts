import { getDb } from "@/lib/db/client";
import { apiHandler } from "@/lib/api/route";
import { getEntryDetail } from "@/lib/ledger/journals";

export const GET = apiHandler({
  permission: "ledger.read",
  handler: async ({ ctx, params }) => {
    const d = await getEntryDetail(getDb(), ctx.orgId, params.id!);
    return { data: { ...d.entry, lines: d.lines.map(({ account, ...l }) => ({ ...l, accountCode: account.code, accountName: account.name })), reversedBy: d.reversedBy?.id ?? null } };
  },
});
