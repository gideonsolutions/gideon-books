import { apiHandler } from "@/lib/api/route";
import { ReverseBody } from "@/lib/api/schemas";
import { reverseManualEntry } from "@/lib/ledger/journals";

/** POST: reverse a manual or opening-balance entry with a linked opposite entry. */
export const POST = apiHandler({
  permission: "ledger.reverse",
  body: ReverseBody,
  idempotent: true,
  status: 201,
  handler: async ({ ctx, params, body }) => {
    const r = await reverseManualEntry(ctx, params.id!, body);
    return { data: { ...r.entry, lines: r.lines } };
  },
});
