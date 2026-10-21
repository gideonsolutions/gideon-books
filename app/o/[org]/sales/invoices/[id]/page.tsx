import { SalesDocumentDetailPage } from "@/components/sales/document-pages";

export const metadata = { title: "Invoice" };

export default async function Page({ params }: { params: Promise<{ org: string; id: string }> }) {
  const p = await params;
  return <SalesDocumentDetailPage slug={p.org} kind="invoice" id={p.id} />;
}
