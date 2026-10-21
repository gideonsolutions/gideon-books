/** Serving sales PDFs to signed-in members of the organization. */
import { NextResponse, type NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { documents } from "@/lib/db/schema/commerce";
import { sessionFromToken } from "@/lib/auth/users";
import { membershipFor, orgBySlug } from "@/lib/orgs/orgs";
import { userCtx, type Ctx } from "@/lib/context";
import { SESSION_COOKIE } from "@/lib/web/session";
import { renderDocumentPdf, renderStatementPdf } from "./pdf";
import { customerStatement } from "./statements";
import { isIsoDate, startOfMonth, todayIn } from "@/lib/dates";

async function memberCtx(req: NextRequest, slug: string): Promise<Ctx | NextResponse> {
  const session = await sessionFromToken(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session || session.session.pendingMfa) return NextResponse.redirect(new URL(`/sign-in?next=${encodeURIComponent(req.nextUrl.pathname)}`, req.url));
  const org = await orgBySlug(getDb(), slug);
  const role = org ? await membershipFor(getDb(), org.id, session.user.id) : null;
  if (!org || !role) return new NextResponse("Not found", { status: 404 });
  return userCtx(org, session.user.id, role, session.user.email, "ui");
}

function pdfResponse(bytes: Uint8Array, fileName: string, download: boolean) {
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `${download ? "attachment" : "inline"}; filename="${fileName.replace(/"/g, "")}"`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    },
  });
}

export async function documentPdfResponse(req: NextRequest, slug: string, id: string): Promise<Response> {
  const ctx = await memberCtx(req, slug);
  if (ctx instanceof NextResponse) return ctx;
  const [doc] = await getDb().select({ side: documents.side }).from(documents).where(and(eq(documents.orgId, ctx.orgId), eq(documents.id, id)));
  if (!doc || doc.side !== "sales") return new NextResponse("Not found", { status: 404 });
  const pdf = await renderDocumentPdf(getDb(), ctx.orgId, id);
  return pdfResponse(pdf.bytes, pdf.fileName, req.nextUrl.searchParams.get("download") === "1");
}

export async function statementPdfResponse(req: NextRequest, slug: string, contactId: string): Promise<Response> {
  const ctx = await memberCtx(req, slug);
  if (ctx instanceof NextResponse) return ctx;
  const today = todayIn(ctx.org.timezone);
  const to = isIsoDate(req.nextUrl.searchParams.get("to")) ? req.nextUrl.searchParams.get("to")! : today;
  const from = isIsoDate(req.nextUrl.searchParams.get("from")) ? req.nextUrl.searchParams.get("from")! : startOfMonth(to);
  try {
    const s = await customerStatement(getDb(), ctx, contactId, from, to);
    const pdf = await renderStatementPdf(getDb(), ctx.orgId, s);
    return pdfResponse(pdf.bytes, pdf.fileName, req.nextUrl.searchParams.get("download") === "1");
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
