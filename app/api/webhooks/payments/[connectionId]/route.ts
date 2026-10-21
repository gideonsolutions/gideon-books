import { NextResponse, type NextRequest } from "next/server";
import { receiveWebhook } from "@/lib/integrations/payments/webhooks";
import { processWebhookEvent } from "@/lib/integrations/payments/process";
import { log } from "@/lib/log";

/**
 * A payment provider's webhook. The signature is checked against the raw
 * body before anything is recorded; the event is stored once (replays are
 * acknowledged and ignored) and its accounting runs as a job. It is also
 * attempted right away, so a payment shows without waiting for the worker;
 * the job then finds it done.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ connectionId: string }> }) {
  const { connectionId } = await params;
  const raw = await req.text();
  if (raw.length > 1_000_000) return NextResponse.json({ error: "too large" }, { status: 413 });
  const result = await receiveWebhook(connectionId, raw, req.headers);
  if (result.eventRowId) {
    await processWebhookEvent(result.eventRowId).catch((e) => log.warn("webhook processing deferred to the job", { eventRowId: result.eventRowId, error: (e as Error).message }));
  }
  return NextResponse.json(result.body, { status: result.status });
}
