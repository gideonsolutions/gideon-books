import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/lib/db/client";
import { sessionFromToken } from "@/lib/auth/users";
import { membershipFor, orgBySlug } from "@/lib/orgs/orgs";
import { userCtx } from "@/lib/context";
import { purchaseOrderPdf } from "@/lib/purchases/pdf";
import { SESSION_COOKIE } from "@/lib/web/session";

/** Download a purchase order as a PDF (members of its organization only). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ org: string; id: string }> }) {
  const { org: slug, id } = await params;
  const session = await sessionFromToken(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session || session.session.pendingMfa) return NextResponse.redirect(new URL(`/sign-in?next=/o/${slug}/purchases/orders/${id}`, req.url));
  const org = await orgBySlug(getDb(), slug);
  const role = org ? await membershipFor(getDb(), org.id, session.user.id) : null;
  if (!org || !role) return new NextResponse("Not found", { status: 404 });
  try {
    const { bytes, fileName } = await purchaseOrderPdf(getDb(), userCtx(org, session.user.id, role, session.user.email), id);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename="${fileName}"`,
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      },
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
