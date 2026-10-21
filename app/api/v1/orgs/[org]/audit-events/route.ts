import { getDb } from "@/lib/db/client";
import { apiHandler } from "@/lib/api/route";
import { listAudit } from "@/lib/audit";

/** GET: the audit trail, newest first; page with ?before=<id>. Filters: entity_type, entity_id, action. */
export const GET = apiHandler({
  permission: "audit.read",
  handler: async ({ ctx, query }) => {
    const rows = await listAudit(getDb(), ctx.orgId, {
      entityType: query.get("entity_type") ?? undefined,
      entityId: query.get("entity_id") ?? undefined,
      action: query.get("action") ?? undefined,
      before: query.get("before") ? Number(query.get("before")) : undefined,
      limit: Math.min(Number(query.get("limit") ?? 100) || 100, 500),
    });
    return { data: rows, next_before: rows.length ? rows[rows.length - 1]!.id : null };
  },
});
