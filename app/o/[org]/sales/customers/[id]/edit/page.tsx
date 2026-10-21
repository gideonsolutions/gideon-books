import { ContactEditPage } from "@/components/contacts/pages";

export const metadata = { title: "Edit customer" };

export default async function Page({ params }: { params: Promise<{ org: string; id: string }> }) {
  const p = await params;
  return <ContactEditPage slug={p.org} role="customer" id={p.id} />;
}
