import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/lib/db/client";
import { sessionFromToken } from "@/lib/auth/users";
import { groupContext, groupAudit } from "@/lib/consolidation/groups";
import { consolidate } from "@/lib/consolidation/report";
import { consolidationCsv } from "@/lib/consolidation/csv";
import { SESSION_COOKIE } from "@/lib/web/session";

/** CSV of a consolidated statement; the same access rule as the page. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ org: string; group: string }> }) {
  const { group: groupId } = await params;
  const session = await sessionFromToken(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session || session.session.pendingMfa) return new NextResponse("Sign in first.", { status: 401 });
  const sp = req.nextUrl.searchParams;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(sp.get("to") ?? "") ? sp.get("to")! : new Date().toISOString().slice(0, 10);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(sp.get("from") ?? "") ? sp.get("from")! : `${to.slice(0, 4)}-01-01`;
  const view = (["trial_balance", "balance_sheet", "profit_and_loss"].includes(sp.get("view") ?? "") ? sp.get("view") : "trial_balance") as "trial_balance" | "balance_sheet" | "profit_and_loss";
  try {
    const g = await groupContext(getDb(), { userId: session.user.id, label: session.user.email }, groupId);
    const r = await consolidate(getDb(), g, from, to);
    await groupAudit(getDb(), g, "group.report_exported", { view, from, to });
    return new NextResponse(consolidationCsv(r, view), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="consolidated-${view}-${to}.csv"`,
        "cache-control": "no-store",
      },
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
