import { SalesDocumentDetailPage } from "@/components/sales/document-pages";

export const metadata = { title: "Sales receipt" };

export default async function Page({ params }: { params: Promise<{ org: string; id: string }> }) {
  const p = await params;
  return <SalesDocumentDetailPage slug={p.org} kind="sales_receipt" id={p.id} />;
}
