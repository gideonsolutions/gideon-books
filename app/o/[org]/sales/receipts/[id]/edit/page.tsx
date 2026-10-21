import { SalesDocumentEditPage } from "@/components/sales/document-pages";

export const metadata = { title: "Edit sales receipt" };

export default async function Page({ params }: { params: Promise<{ org: string; id: string }> }) {
  const p = await params;
  return <SalesDocumentEditPage slug={p.org} kind="sales_receipt" id={p.id} />;
}
