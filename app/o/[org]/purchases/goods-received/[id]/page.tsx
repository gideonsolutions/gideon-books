import { notFound, redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { purchaseReceipts } from "@/lib/db/schema/purchasing";
import { orgCtx } from "@/lib/web/session";

/** A goods receipt lives on its purchase order's page. */
export default async function GoodsReceived({ params }: { params: Promise<{ org: string; id: string }> }) {
  const { org, id } = await params;
  const ctx = await orgCtx(org);
  const [r] = await getDb()
    .select({ po: purchaseReceipts.purchaseOrderId })
    .from(purchaseReceipts)
    .where(and(eq(purchaseReceipts.orgId, ctx.orgId), eq(purchaseReceipts.id, id)));
  if (!r) notFound();
  redirect(`/o/${org}/purchases/orders/${r.po}`);
}
