import { ContactDetailPage } from "@/components/contacts/pages";

export const metadata = { title: "Vendor" };

export default async function Page({ params }: { params: Promise<{ org: string; id: string }> }) {
  const p = await params;
  return <ContactDetailPage slug={p.org} role="vendor" id={p.id} />;
}
