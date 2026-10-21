import { SalesDocumentNewPage } from "@/components/sales/document-pages";
import type { SearchParams } from "@/lib/web/params";

export const metadata = { title: "New sales receipt" };

export default async function Page({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  return <SalesDocumentNewPage slug={(await params).org} kind="sales_receipt" searchParams={searchParams} />;
}
