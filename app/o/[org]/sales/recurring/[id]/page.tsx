import { RecurringDetailPage } from "@/components/sales/recurring-pages";
import { readParams, type SearchParams } from "@/lib/web/params";

export const metadata = { title: "Recurring invoice" };

export default async function Page({ params, searchParams }: { params: Promise<{ org: string; id: string }>; searchParams: SearchParams }) {
  const p = await params;
  const sp = await readParams(searchParams);
  return <RecurringDetailPage slug={p.org} id={p.id} isNew={sp.new === "1"} />;
}
