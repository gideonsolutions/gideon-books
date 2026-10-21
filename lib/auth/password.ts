/**
 * Password hashing with scrypt (Node's built-in, memory-hard). Stored as
 * scrypt$N$r$p$salt$hash so parameters can be raised later; verification is
 * constant-time.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEYLEN = 64;

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize("NFKC"), salt, KEYLEN, { N, r: R, p: P, maxmem: 128 * N * R * 2 });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) {
    // Spend the same time as a real check so timing does not reveal whether an account exists.
    await hashPassword(password);
    return false;
  }
  const [alg, n, r, p, saltB64, keyB64] = stored.split("$");
  if (alg !== "scrypt" || !n || !r || !p || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, "base64url");
  const key = await scrypt(password.normalize("NFKC"), Buffer.from(saltB64, "base64url"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 128 * Number(n) * Number(r) * 2,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Minimum rules: 10+ characters, not all one class of character, not a well-known password. */
export function passwordProblem(password: string, email?: string): string | null {
  if (password.length < 10) return "Use at least 10 characters.";
  if (password.length > 200) return "Use at most 200 characters.";
  const lower = password.toLowerCase();
  if (email && lower.includes(email.split("@")[0]!.toLowerCase()) && email.split("@")[0]!.length >= 4) return "Do not include your email name.";
  if (/^(.)\1+$/.test(password)) return "Use more than one repeated character.";
  const common = ["password", "1234567890", "qwertyuiop", "letmein", "welcome", "iloveyou", "admin", "passw0rd", "gideon"];
  if (common.some((c) => lower.includes(c))) return "That password is too easy to guess.";
  return null;
}
