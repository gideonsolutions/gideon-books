import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/lib/db/client";
import { sessionFromToken } from "@/lib/auth/users";
import { membershipFor, orgBySlug } from "@/lib/orgs/orgs";
import { requirePermission, userCtx } from "@/lib/context";
import { audit } from "@/lib/audit";
import { buildReport, reportDef } from "@/lib/reports/registry";
import { toCsv, toPdf } from "@/lib/reports/export";
import { SESSION_COOKIE } from "@/lib/web/session";
import { isAppError } from "@/lib/errors";

/** Download a report as CSV or PDF — the same table the page shows. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ org: string; report: string }> }) {
  const { org: slug, report } = await params;
  const def = reportDef(report);
  if (!def) return new NextResponse("Not found", { status: 404 });
  const session = await sessionFromToken(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session || session.session.pendingMfa) return NextResponse.redirect(new URL(`/sign-in?next=${encodeURIComponent(req.nextUrl.pathname + req.nextUrl.search)}`, req.url));
  const db = getDb();
  const org = await orgBySlug(db, slug);
  const role = org ? await membershipFor(db, org.id, session.user.id) : null;
  if (!org || !role) return new NextResponse("Not found", { status: 404 });
  const ctx = userCtx(org, session.user.id, role, session.user.email, "ui");
  try {
    requirePermission(ctx, "reports.read");
  } catch {
    return new NextResponse("Forbidden", { status: 403 });
  }
  const sp: Record<string, string | undefined> = {};
  req.nextUrl.searchParams.forEach((v, k) => (sp[k] = v));
  const format = sp.format === "pdf" ? "pdf" : "csv";
  try {
    const table = await buildReport(db, org, def.key, sp);
    await audit(db, ctx, { action: "report.exported", entityType: "report", entityId: null, metadata: { report: def.key, format, subtitle: table.subtitle, params: sp } });
    const name = `${org.slug}-${def.key}-${(sp.to ?? "").slice(0, 10) || "report"}`.replace(/[^a-z0-9-]/gi, "-");
    if (format === "pdf") {
      const bytes = await toPdf(table, org.name);
      return new NextResponse(new Uint8Array(bytes), {
        headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${name}.pdf"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
      });
    }
    return new NextResponse(toCsv(table), {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}.csv"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
    });
  } catch (e) {
    if (isAppError(e)) return NextResponse.json(e.toJSON(), { status: e.status });
    return new NextResponse("The report could not be produced.", { status: 400 });
  }
}
