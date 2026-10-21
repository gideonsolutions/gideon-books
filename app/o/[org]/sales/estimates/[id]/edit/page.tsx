import { SalesDocumentEditPage } from "@/components/sales/document-pages";

export const metadata = { title: "Edit estimate" };

export default async function Page({ params }: { params: Promise<{ org: string; id: string }> }) {
  const p = await params;
  return <SalesDocumentEditPage slug={p.org} kind="estimate" id={p.id} />;
}
