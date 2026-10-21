import { SalesDocumentListPage } from "@/components/sales/document-pages";
import type { SearchParams } from "@/lib/web/params";

export const metadata = { title: "Sales receipts" };

export default async function Page({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  return <SalesDocumentListPage slug={(await params).org} kind="sales_receipt" searchParams={searchParams} />;
}
