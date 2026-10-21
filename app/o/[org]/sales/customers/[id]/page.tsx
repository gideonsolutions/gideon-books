import { ContactDetailPage } from "@/components/contacts/pages";

export const metadata = { title: "Customer" };

export default async function Page({ params }: { params: Promise<{ org: string; id: string }> }) {
  const p = await params;
  return <ContactDetailPage slug={p.org} role="customer" id={p.id} />;
}
