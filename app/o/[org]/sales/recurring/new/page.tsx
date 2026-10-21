import { RecurringNewPage } from "@/components/sales/recurring-pages";

export const metadata = { title: "New recurring invoice" };

export default async function Page({ params }: { params: Promise<{ org: string }> }) {
  return <RecurringNewPage slug={(await params).org} />;
}
