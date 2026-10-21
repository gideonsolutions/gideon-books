import { notFound, redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { documents } from "@/lib/db/schema/commerce";
import { orgCtx } from "@/lib/web/session";
import { documentPath } from "@/lib/web/routes";

/** /documents/<id> resolves to the document's own page, whatever its kind. */
export default async function DocumentRedirect({ params }: { params: Promise<{ org: string; id: string }> }) {
  const { org, id } = await params;
  const ctx = await orgCtx(org);
  const [d] = await getDb().select({ kind: documents.kind }).from(documents).where(and(eq(documents.orgId, ctx.orgId), eq(documents.id, id)));
  if (!d) notFound();
  redirect(documentPath(`/o/${org}`, d.kind, id));
}
