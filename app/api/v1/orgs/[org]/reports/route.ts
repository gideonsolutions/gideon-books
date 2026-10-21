import { apiHandler } from "@/lib/api/route";
import { REPORTS } from "@/lib/reports/registry";

/** GET: the reports available, with their keys and descriptions. */
export const GET = apiHandler({
  permission: "reports.read",
  handler: async () => ({ data: REPORTS.map((r) => ({ key: r.key, title: r.title, description: r.description, category: r.category })) }),
});
