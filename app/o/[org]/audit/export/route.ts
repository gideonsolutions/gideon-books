import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/lib/db/client";
import { sessionFromToken } from "@/lib/auth/users";
import { membershipFor, orgBySlug } from "@/lib/orgs/orgs";
import { can, userCtx } from "@/lib/context";
import { audit } from "@/lib/audit";
import { auditCsv } from "@/lib/ops/audit-log";
import { SESSION_COOKIE } from "@/lib/web/session";

/** The filtered audit trail as CSV (audit.read; the export itself is audited). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ org: string }> }) {
  const { org: slug } = await params;
  const session = await sessionFromToken(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session || session.session.pendingMfa) return new NextResponse("Sign in first.", { status: 401 });
  const org = await orgBySlug(getDb(), slug);
  const role = org ? await membershipFor(getDb(), org.id, session.user.id) : null;
  if (!org || !role) return new NextResponse("Not found", { status: 404 });
  const ctx = userCtx(org, session.user.id, role, session.user.email, "ui");
  if (!can(ctx, "audit.read")) return new NextResponse("Forbidden", { status: 403 });
  const sp = req.nextUrl.searchParams;
  const date = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
  const csv = await auditCsv(getDb(), org.id, {
    action: sp.get("action") ?? undefined,
    entityType: sp.get("entity") ?? undefined,
    entityId: sp.get("id") ?? undefined,
    actor: sp.get("actor") ?? undefined,
    from: date(sp.get("from")),
    to: date(sp.get("to")),
  });
  await audit(getDb(), ctx, { action: "audit.exported", entityType: "organization", entityId: org.id });
  return new NextResponse(csv, {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="audit-log-${org.slug}.csv"`, "cache-control": "no-store" },
  });
}
