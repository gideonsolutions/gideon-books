import { PaymentDetailPage } from "@/components/sales/payment-pages";

export const metadata = { title: "Payment" };

export default async function Page({ params }: { params: Promise<{ org: string; id: string }> }) {
  const p = await params;
  return <PaymentDetailPage slug={p.org} id={p.id} />;
}
