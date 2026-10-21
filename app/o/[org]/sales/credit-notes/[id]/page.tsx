import { SalesDocumentDetailPage } from "@/components/sales/document-pages";

export const metadata = { title: "Credit note" };

export default async function Page({ params }: { params: Promise<{ org: string; id: string }> }) {
  const p = await params;
  return <SalesDocumentDetailPage slug={p.org} kind="credit_note" id={p.id} />;
}
