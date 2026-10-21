import { notFound } from "next/navigation";
import { sandboxCheckoutView } from "@/lib/integrations/payments/sandbox-sim";
import { Alert, Money } from "@/components/ui";
import { ActionButton } from "@/components/client/forms";
import { readParams, type SearchParams } from "@/lib/web/params";
import { sandboxPayAction } from "./actions";

export const metadata = { title: "Pay an invoice" };

/**
 * The checkout page for a payment link. For a real provider the link goes to
 * the provider's own checkout and this page is only where it returns; for
 * the sandbox it is the checkout itself, plainly labeled: nothing is charged.
 */
export default async function PayPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: SearchParams }) {
  const { token } = await params;
  const sp = await readParams(searchParams);
  const view = await sandboxCheckoutView(token);
  if (!view) notFound();
  const { link } = view;
  const paid = link.status === "paid";
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-sm text-slate-500">{view.orgName}</p>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">Invoice {view.invoiceNumber}</h1>
        <div className="num mt-4 text-3xl font-semibold">
          <Money amount={link.amount} currency={link.currency} />
        </div>
        {link.provider === "sandbox" && (
          <div className="mt-4">
            <Alert tone="warning" title="Sandbox checkout">
              This is a test page. Paying here charges no card and moves no money; it only shows how a real payment would be recorded.
            </Alert>
          </div>
        )}
        <div className="mt-6">
          {paid || sp.done ? (
            <Alert tone="success" title="Thank you">
              {paid ? "This invoice is paid." : "Your payment is being confirmed."}
            </Alert>
          ) : sp.cancelled ? (
            <Alert tone="info">The payment was cancelled. You can try again.</Alert>
          ) : link.status !== "open" ? (
            <Alert tone="info">This payment link is no longer active. Ask for a new one.</Alert>
          ) : link.provider === "sandbox" ? (
            <ActionButton variant="primary" action={sandboxPayAction.bind(null, token)}>
              Pay (sandbox — no real money)
            </ActionButton>
          ) : (
            <a href={link.url} className="inline-flex rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
              Continue to secure checkout
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
