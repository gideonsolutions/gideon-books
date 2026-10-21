import { PaymentListPage } from "@/components/sales/payment-pages";
import type { SearchParams } from "@/lib/web/params";

export const metadata = { title: "Payments received" };

export default async function Page({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  return <PaymentListPage slug={(await params).org} searchParams={searchParams} />;
}
