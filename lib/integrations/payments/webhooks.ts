/**
 * Receiving a provider's webhook: verify the signature and timestamp before
 * anything else, record the event (the unique (provider, event id) refuses a
 * replay), and queue its processing. The accounting happens in the job
 * (process.ts), so a slow or failing step never loses an event.
 */
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { integrationConnections, webhookEvents } from "@/lib/db/schema/core";
import { enqueue } from "@/lib/jobs/queue";
import { log } from "@/lib/log";
import { connectionSecrets, providerFor } from "./connections";
import { SignatureError, verifySignature } from "./signature";

export interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
  eventRowId?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function receiveWebhook(connectionId: string, rawBody: string, headers: Headers, opts: { nowSeconds?: number } = {}): Promise<WebhookResult> {
  if (!UUID_RE.test(connectionId)) return { status: 404, body: { error: "unknown endpoint" } };
  const db = getDb();
  const [conn] = await db.select().from(integrationConnections).where(eq(integrationConnections.id, connectionId));
  if (!conn || conn.kind !== "payments" || conn.status === "disconnected") return { status: 404, body: { error: "unknown endpoint" } };
  const provider = providerFor(conn);
  let secret: string;
  try {
    secret = connectionSecrets(conn).webhookSecret;
  } catch {
    return { status: 500, body: { error: "connection misconfigured" } };
  }
  try {
    verifySignature(headers.get(provider.signatureHeader), rawBody, secret, opts.nowSeconds !== undefined ? { nowSeconds: opts.nowSeconds } : {});
  } catch (e) {
    if (e instanceof SignatureError) {
      log.warn("webhook signature refused", { connectionId, provider: conn.provider, reason: e.reason });
      return { status: 400, body: { error: `signature ${e.reason}` } };
    }
    throw e;
  }
  let event: { id?: unknown; type?: unknown };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: "body is not JSON" } };
  }
  if (typeof event.id !== "string" || typeof event.type !== "string") return { status: 400, body: { error: "not an event" } };
  const inserted = await db
    .insert(webhookEvents)
    .values({
      orgId: conn.orgId,
      connectionId: conn.id,
      provider: conn.provider,
      eventId: event.id,
      eventType: event.type,
      payload: event,
      signatureVerified: true,
    })
    .onConflictDoNothing()
    .returning();
  if (!inserted.length) {
    // A replay (or the provider's retry of an event we already have): acknowledged, not processed again.
    return { status: 200, body: { received: true, duplicate: true } };
  }
  const row = inserted[0]!;
  await enqueue(db, "payments.process_event", { eventRowId: row.id }, { orgId: conn.orgId, dedupeKey: `webhook:${row.id}`, maxAttempts: 8 });
  return { status: 200, body: { received: true }, eventRowId: row.id };
}
