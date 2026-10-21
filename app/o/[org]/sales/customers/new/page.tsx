import { ContactNewPage } from "@/components/contacts/pages";

export const metadata = { title: "New customer" };

export default async function Page({ params }: { params: Promise<{ org: string }> }) {
  return <ContactNewPage slug={(await params).org} role="customer" />;
}
