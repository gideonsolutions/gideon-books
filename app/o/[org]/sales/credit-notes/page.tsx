import { SalesDocumentListPage } from "@/components/sales/document-pages";
import type { SearchParams } from "@/lib/web/params";

export const metadata = { title: "Credit notes" };

export default async function Page({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  return <SalesDocumentListPage slug={(await params).org} kind="credit_note" searchParams={searchParams} />;
}
