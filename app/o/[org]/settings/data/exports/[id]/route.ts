import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/lib/db/client";
import { sessionFromToken } from "@/lib/auth/users";
import { membershipFor, orgBySlug } from "@/lib/orgs/orgs";
import { userCtx } from "@/lib/context";
import { readExport } from "@/lib/ops/export";
import { SESSION_COOKIE } from "@/lib/web/session";

/** Download a completed export (members with data.export only; audited). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ org: string; id: string }> }) {
  const { org: slug, id } = await params;
  const session = await sessionFromToken(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session || session.session.pendingMfa) return NextResponse.redirect(new URL(`/sign-in?next=/o/${slug}/settings/data`, req.url));
  const org = await orgBySlug(getDb(), slug);
  const role = org ? await membershipFor(getDb(), org.id, session.user.id) : null;
  if (!org || !role) return new NextResponse("Not found", { status: 404 });
  try {
    const { row, bytes } = await readExport(userCtx(org, session.user.id, role, session.user.email, "ui"), id);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "content-type": "application/zip",
        "content-length": String(bytes.length),
        "content-disposition": `attachment; filename="${(row.fileName ?? "export.zip").replace(/"/g, "")}"`,
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      },
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
