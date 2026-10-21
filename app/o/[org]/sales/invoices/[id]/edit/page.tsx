import { SalesDocumentEditPage } from "@/components/sales/document-pages";

export const metadata = { title: "Edit invoice" };

export default async function Page({ params }: { params: Promise<{ org: string; id: string }> }) {
  const p = await params;
  return <SalesDocumentEditPage slug={p.org} kind="invoice" id={p.id} />;
}
