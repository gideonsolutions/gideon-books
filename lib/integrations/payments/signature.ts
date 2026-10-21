/**
 * Webhook signatures in Stripe's scheme, which the sandbox uses too: a
 * header `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`. A
 * signature is accepted only with the right secret and a timestamp within
 * the tolerance (default five minutes), so a captured request cannot be
 * replayed later; the unique event id refuses a replay inside the window.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const DEFAULT_TOLERANCE_SECONDS = 300;

export class SignatureError extends Error {
  constructor(
    message: string,
    readonly reason: "missing" | "malformed" | "mismatch" | "stale",
  ) {
    super(message);
  }
}

export function signPayload(body: string, secret: string, timestampSeconds = Math.floor(Date.now() / 1000)): string {
  const sig = createHmac("sha256", secret).update(`${timestampSeconds}.${body}`).digest("hex");
  return `t=${timestampSeconds},v1=${sig}`;
}

export function verifySignature(header: string | null | undefined, body: string, secret: string, opts: { nowSeconds?: number; toleranceSeconds?: number } = {}): { timestamp: number } {
  if (!header) throw new SignatureError("The signature header is missing.", "missing");
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2).map((s) => s.trim());
    if (k === "t" && v && /^\d+$/.test(v)) t = Number(v);
    else if (k === "v1" && v) v1.push(v);
  }
  if (t === null || v1.length === 0) throw new SignatureError("The signature header is malformed.", "malformed");
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${body}`).digest("hex"));
  const ok = v1.some((s) => {
    const b = Buffer.from(s);
    return b.length === expected.length && timingSafeEqual(b, expected);
  });
  if (!ok) throw new SignatureError("The signature does not match.", "mismatch");
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS)) {
    throw new SignatureError("The signature timestamp is too old (or in the future).", "stale");
  }
  return { timestamp: t };
}
