import { ContactListPage } from "@/components/contacts/pages";
import type { SearchParams } from "@/lib/web/params";

export const metadata = { title: "Vendors" };

export default async function Page({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  return <ContactListPage slug={(await params).org} role="vendor" searchParams={searchParams} />;
}
