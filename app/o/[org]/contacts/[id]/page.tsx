import { notFound, redirect } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { getContact } from "@/lib/contacts/contacts";

/** /contacts/<id> resolves to the customer or vendor page. */
export default async function ContactRedirect({ params }: { params: Promise<{ org: string; id: string }> }) {
  const { org, id } = await params;
  const ctx = await orgCtx(org);
  const c = await getContact(getDb(), ctx.orgId, id).catch(() => null);
  if (!c) notFound();
  redirect(`/o/${org}/${c.isCustomer || !c.isVendor ? "sales/customers" : "purchases/vendors"}/${id}`);
}
