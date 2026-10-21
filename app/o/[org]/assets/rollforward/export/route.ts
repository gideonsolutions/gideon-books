import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/lib/db/client";
import { sessionFromToken } from "@/lib/auth/users";
import { membershipFor, orgBySlug } from "@/lib/orgs/orgs";
import { can, userCtx } from "@/lib/context";
import { assetRollforward, rollforwardCsv } from "@/lib/assets/reports";
import { audit } from "@/lib/audit";
import { SESSION_COOKIE } from "@/lib/web/session";

/** CSV of the fixed-asset rollforward, for members who may read reports. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ org: string }> }) {
  const { org: slug } = await params;
  const session = await sessionFromToken(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session || session.session.pendingMfa) return NextResponse.redirect(new URL(`/sign-in?next=/o/${slug}/assets/rollforward`, req.url));
  const db = getDb();
  const org = await orgBySlug(db, slug);
  const role = org ? await membershipFor(db, org.id, session.user.id) : null;
  if (!org || !role) return new NextResponse("Not found", { status: 404 });
  const ctx = userCtx(org, session.user.id, role, session.user.email, "ui");
  if (!can(ctx, "reports.read")) return new NextResponse("Forbidden", { status: 403 });
  const from = req.nextUrl.searchParams.get("from") ?? "";
  const to = req.nextUrl.searchParams.get("to") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return new NextResponse("from and to must be dates (YYYY-MM-DD)", { status: 400 });
  const r = await assetRollforward(db, ctx.orgId, from, to);
  await audit(db, ctx, { action: "report.exported", entityType: "report", entityId: null, metadata: { report: "fixed_asset_rollforward", from, to, format: "csv" } });
  return new NextResponse(rollforwardCsv(r, org.baseCurrency), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="fixed-asset-rollforward-${from}-to-${to}.csv"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
