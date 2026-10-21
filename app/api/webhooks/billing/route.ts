import { NextResponse, type NextRequest } from "next/server";
import { handleBillingWebhook } from "@/lib/hosted/billing";
import { isAppError } from "@/lib/errors";
import { log } from "@/lib/log";

/**
 * Stripe Billing webhooks for the hosted subscription. The signature and
 * timestamp are checked before anything is stored; a replayed event id is
 * acknowledged without being applied again.
 */
export async function POST(req: NextRequest) {
  const body = await req.text();
  try {
    const r = await handleBillingWebhook(body, req.headers.get("stripe-signature"));
    return NextResponse.json({ received: true, status: r.status });
  } catch (e) {
    if (isAppError(e)) return NextResponse.json(e.toJSON(), { status: e.status === 422 ? 400 : e.status });
    log.error("billing webhook error", { error: (e as Error).message });
    return NextResponse.json({ error: { code: "internal_error" } }, { status: 500 });
  }
}
