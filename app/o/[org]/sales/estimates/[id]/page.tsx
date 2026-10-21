import { SalesDocumentDetailPage } from "@/components/sales/document-pages";

export const metadata = { title: "Estimate" };

export default async function Page({ params }: { params: Promise<{ org: string; id: string }> }) {
  const p = await params;
  return <SalesDocumentDetailPage slug={p.org} kind="estimate" id={p.id} />;
}
