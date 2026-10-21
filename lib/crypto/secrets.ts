/**
 * Encryption of secrets at rest (provider API keys, bank-feed access URLs,
 * TOTP seeds) with AES-256-GCM under a key derived from BOOKS_ENCRYPTION_KEY.
 * Stored as v1.<iv>.<ciphertext>.<tag>, base64url. Rotating the key: set
 * BOOKS_ENCRYPTION_KEY_PREVIOUS to the old key while re-encrypting.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

function keyFrom(secret: string): Buffer {
  return createHash("sha256").update(`gideon-books:v1:${secret}`).digest();
}

function currentKey(): Buffer {
  const k = process.env.BOOKS_ENCRYPTION_KEY;
  if (!k || k.length < 32) {
    throw new Error("BOOKS_ENCRYPTION_KEY must be set to at least 32 random characters (see .env.example).");
  }
  return keyFrom(k);
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", currentKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), ct.toString("base64url"), tag.toString("base64url")].join(".");
}

export function decryptSecret(stored: string): string {
  const [v, ivB, ctB, tagB] = stored.split(".");
  if (v !== "v1" || !ivB || !ctB || !tagB) throw new Error("unrecognized secret format");
  const keys = [currentKey()];
  if (process.env.BOOKS_ENCRYPTION_KEY_PREVIOUS) keys.push(keyFrom(process.env.BOOKS_ENCRYPTION_KEY_PREVIOUS));
  let lastErr: unknown;
  for (const key of keys) {
    try {
      const d = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB, "base64url"));
      d.setAuthTag(Buffer.from(tagB, "base64url"));
      return Buffer.concat([d.update(Buffer.from(ctB, "base64url")), d.final()]).toString("utf8");
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`could not decrypt secret: ${(lastErr as Error)?.message}`);
}

export function sha256Hex(v: string | Buffer): string {
  return createHash("sha256").update(v).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Show only the last few characters of a secret. */
export function maskSecret(v: string | null | undefined, keep = 4): string {
  if (!v) return "";
  return v.length <= keep ? "•".repeat(v.length) : `${"•".repeat(Math.min(8, v.length - keep))}${v.slice(-keep)}`;
}
