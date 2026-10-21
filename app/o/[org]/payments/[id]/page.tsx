import { notFound, redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { payments } from "@/lib/db/schema/commerce";
import { orgCtx } from "@/lib/web/session";
import { paymentPath } from "@/lib/web/routes";

/** /payments/<id> resolves to the payment's own page. */
export default async function PaymentRedirect({ params }: { params: Promise<{ org: string; id: string }> }) {
  const { org, id } = await params;
  const ctx = await orgCtx(org);
  const [p] = await getDb().select({ kind: payments.kind }).from(payments).where(and(eq(payments.orgId, ctx.orgId), eq(payments.id, id)));
  if (!p) notFound();
  redirect(paymentPath(`/o/${org}`, p.kind, id));
}
