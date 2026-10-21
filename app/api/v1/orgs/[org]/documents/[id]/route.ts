import { getDb } from "@/lib/db/client";
import { apiHandler } from "@/lib/api/route";
import { getDocument } from "@/lib/commerce/documents";
import { itemBalance } from "@/lib/commerce/open-items";
import { settlementsForItem } from "@/lib/commerce/settlements";

export const GET = apiHandler({
  permission: "org.read",
  handler: async ({ ctx, params }) => {
    const d = await getDocument(getDb(), ctx.orgId, params.id!);
    const bal = await itemBalance(getDb(), ctx.orgId, d.doc.id);
    const applications = await settlementsForItem(getDb(), ctx.orgId, d.doc.id);
    return { data: { ...d.doc, lines: d.lines, taxes: d.taxes, openBalance: bal.txn.abs().toString(), applications } };
  },
});
