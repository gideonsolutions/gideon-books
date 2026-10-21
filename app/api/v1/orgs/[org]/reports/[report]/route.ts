import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { apiHandler } from "@/lib/api/route";
import { audit } from "@/lib/audit";
import { buildReport, reportDef } from "@/lib/reports/registry";
import { toCsv } from "@/lib/reports/export";
import { NotFoundError } from "@/lib/errors";

/**
 * GET: a report as data — the same table the page, CSV and PDF show. Takes the
 * page's parameters (from, to, asOf, basis=accrual|cash, compare, columns,
 * account, contact, project, class, department, location, fund, …);
 * ?format=csv returns CSV instead of JSON.
 */
export const GET = apiHandler({
  permission: "reports.read",
  handler: async ({ ctx, params, query }) => {
    const def = reportDef(params.report ?? "");
    if (!def) throw new NotFoundError("That report");
    const sp: Record<string, string | undefined> = {};
    query.forEach((v, k) => (sp[k] = v));
    const table = await buildReport(getDb(), ctx.org, def.key, sp);
    await audit(getDb(), ctx, { action: "report.exported", entityType: "report", entityId: null, metadata: { report: def.key, format: sp.format ?? "json", via: "api" } });
    if (sp.format === "csv") {
      return new NextResponse(toCsv(table), { headers: { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store" } });
    }
    return { data: table };
  },
});
