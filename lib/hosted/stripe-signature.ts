/**
 * Stripe webhook signatures: the `Stripe-Signature` header carries a
 * timestamp (t=) and one or more HMAC-SHA256 signatures (v1=) of
 * `${t}.${raw body}` under the endpoint's signing secret. An event is
 * accepted only if a signature matches and the timestamp is within the
 * tolerance (default five minutes), so a captured request cannot be replayed
 * later; replays within the window are refused by the stored event id.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export class SignatureError extends Error {}

export function signStripePayload(body: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const sig = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${sig}`;
}

export function verifyStripeSignature(body: string, header: string | null, secret: string, opts: { toleranceSeconds?: number; now?: number } = {}): void {
  if (!header) throw new SignatureError("missing Stripe-Signature header");
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2).map((s) => s.trim());
    if (k === "t" && v) t = Number(v);
    if (k === "v1" && v) v1.push(v);
  }
  if (t === null || !Number.isFinite(t) || v1.length === 0) throw new SignatureError("malformed Stripe-Signature header");
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (opts.toleranceSeconds ?? 300)) throw new SignatureError("timestamp outside the tolerance");
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${body}`).digest("hex"));
  const ok = v1.some((s) => {
    const got = Buffer.from(s);
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
  if (!ok) throw new SignatureError("signature does not match");
}
