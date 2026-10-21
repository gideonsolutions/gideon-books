import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/lib/db/client";
import { sessionFromToken } from "@/lib/auth/users";
import { membershipFor, orgBySlug } from "@/lib/orgs/orgs";
import { userCtx } from "@/lib/context";
import { readAttachment } from "@/lib/storage/attachments";
import { audit } from "@/lib/audit";
import { SESSION_COOKIE } from "@/lib/web/session";

/**
 * Download an attachment. Only members of the organization it belongs to;
 * served as a download (or inline for PDFs and images) with no sniffing and
 * a sandbox, so a file can never run as a page of this site.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ org: string; id: string }> }) {
  const { org: slug, id } = await params;
  const session = await sessionFromToken(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session || session.session.pendingMfa) return NextResponse.redirect(new URL(`/sign-in?next=/o/${slug}/files/${id}`, req.url));
  const org = await orgBySlug(getDb(), slug);
  const role = org ? await membershipFor(getDb(), org.id, session.user.id) : null;
  if (!org || !role) return new NextResponse("Not found", { status: 404 });
  const ctx = userCtx(org, session.user.id, role, session.user.email, "ui");
  try {
    const { row, bytes } = await readAttachment(getDb(), ctx, id);
    await audit(getDb(), ctx, { action: "attachment.downloaded", entityType: row.entityType, entityId: row.entityId, metadata: { attachmentId: id } });
    const inline = /^(application\/pdf|image\/(png|jpeg|gif|webp))$/.test(row.contentType) && req.nextUrl.searchParams.get("download") !== "1";
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "content-type": row.contentType,
        "content-length": String(bytes.length),
        "content-disposition": `${inline ? "inline" : "attachment"}; filename="${row.fileName.replace(/"/g, "")}"`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
        "cache-control": "private, no-store",
      },
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
