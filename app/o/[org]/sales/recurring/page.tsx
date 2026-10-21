import { RecurringListPage } from "@/components/sales/recurring-pages";

export const metadata = { title: "Recurring invoices" };

export default async function Page({ params }: { params: Promise<{ org: string }> }) {
  return <RecurringListPage slug={(await params).org} />;
}
