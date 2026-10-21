import { PaymentNewPage } from "@/components/sales/payment-pages";
import type { SearchParams } from "@/lib/web/params";

export const metadata = { title: "Receive payment" };

export default async function Page({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  return <PaymentNewPage slug={(await params).org} searchParams={searchParams} />;
}
