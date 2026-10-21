import { ContactListPage } from "@/components/contacts/pages";
import type { SearchParams } from "@/lib/web/params";

export const metadata = { title: "Customers" };

export default async function Page({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  return <ContactListPage slug={(await params).org} role="customer" searchParams={searchParams} />;
}
