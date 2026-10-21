/**
 * SimpleFIN Bridge (https://www.simplefin.org/protocol.html): an open
 * protocol where the person buys access from a bridge, gets a one-time setup
 * token, and we claim a long-lived access URL with it. The access URL holds
 * its own credentials (https://user:pass@host/path); it is stored encrypted
 * and never shown again.
 *
 * Unverified without a live SimpleFIN account: the adapter follows the
 * published protocol (claim by POST to the base64-decoded setup token; GET
 * {access}/accounts?start-date=&end-date= with basic auth) and is tested
 * against recorded responses of that shape.
 */
import { IntegrationError, ValidationError } from "@/lib/errors";
import { Decimal } from "@/lib/money/decimal";
import { isCurrency } from "@/lib/money/currency";
import type { FeedAccount, FeedProvider } from "./types";

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...a) => fetch(...a);
export function setSimplefinFetchForTests(f: Fetch | null) {
  fetchImpl = f ?? ((...a) => fetch(...a));
}

function decodeSetupToken(token: string): URL {
  let decoded: string;
  try {
    decoded = Buffer.from(token.trim(), "base64").toString("utf8").trim();
  } catch {
    throw new ValidationError("That is not a SimpleFIN setup token.", { setupToken: "Paste the setup token from your SimpleFIN Bridge." });
  }
  let url: URL;
  try {
    url = new URL(decoded);
  } catch {
    throw new ValidationError("That is not a SimpleFIN setup token.", { setupToken: "Paste the setup token from your SimpleFIN Bridge." });
  }
  if (url.protocol !== "https:") throw new ValidationError("SimpleFIN setup tokens point at an https address.", { setupToken: "Not an https claim URL." });
  return url;
}

function epochDate(v: unknown): string | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString().slice(0, 10);
}

function toEpoch(iso: string): number {
  return Math.floor(Date.parse(`${iso}T00:00:00Z`) / 1000);
}

interface SfAccount {
  id?: string;
  name?: string;
  currency?: string;
  balance?: string;
  "balance-date"?: number;
  org?: { name?: string; domain?: string };
  transactions?: { id?: string; posted?: number; amount?: string; description?: string; payee?: string; memo?: string; pending?: boolean }[];
}

export function mapSimplefinAccounts(body: { accounts?: SfAccount[]; errors?: string[] }): { accounts: FeedAccount[]; warnings: string[] } {
  const accounts: FeedAccount[] = [];
  for (const a of body.accounts ?? []) {
    if (!a.id) continue;
    const txns = [];
    for (const t of a.transactions ?? []) {
      const posted = epochDate(t.posted);
      // Pending transactions (posted = 0) are not on the statement yet.
      if (!t.id || !posted || t.pending) continue;
      const amount = Decimal.tryFrom(String(t.amount ?? "").trim());
      if (!amount) continue;
      txns.push({
        id: String(t.id),
        postedDate: posted,
        amount: amount.toString(),
        description: (t.description ?? t.payee ?? "").toString().slice(0, 500),
        payee: t.payee ? String(t.payee).slice(0, 200) : null,
        memo: t.memo ? String(t.memo) : null,
        raw: t,
      });
    }
    accounts.push({
      id: String(a.id),
      name: String(a.name ?? "Account"),
      institution: a.org?.name ?? a.org?.domain ?? null,
      currency: a.currency && isCurrency(a.currency) ? a.currency : null,
      balance: Decimal.tryFrom(a.balance ?? null)?.toString() ?? null,
      balanceDate: epochDate(a["balance-date"]),
      transactions: txns,
    });
  }
  return { accounts, warnings: (body.errors ?? []).map(String) };
}

export const simplefinProvider: FeedProvider = {
  name: "simplefin",
  label: "SimpleFIN Bridge",
  mode: "live",
  async connect(setupToken: string) {
    const claim = decodeSetupToken(setupToken);
    let res: Response;
    try {
      res = await fetchImpl(claim.toString(), { method: "POST", headers: { "content-length": "0" }, signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      throw new IntegrationError(`Could not reach the SimpleFIN Bridge (${(e as Error).message}).`, "feed_unreachable");
    }
    if (res.status === 403) throw new IntegrationError("SimpleFIN refused the setup token: it was already used or has expired. Create a new one in your bridge.", "feed_token_used");
    if (!res.ok) throw new IntegrationError(`SimpleFIN answered ${res.status} when claiming the token.`, "feed_error");
    const accessUrl = (await res.text()).trim();
    let parsed: URL;
    try {
      parsed = new URL(accessUrl);
    } catch {
      throw new IntegrationError("SimpleFIN returned something that is not an access URL.", "feed_error");
    }
    return { secret: accessUrl, displayName: `SimpleFIN (${parsed.host})` };
  },
  async fetch(accessUrl, range) {
    const u = new URL(accessUrl);
    const auth = Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString("base64");
    u.username = "";
    u.password = "";
    const base = u.toString().replace(/\/$/, "");
    const url = `${base}/accounts?start-date=${toEpoch(range.start)}&end-date=${toEpoch(range.end) + 86_399}`;
    let res: Response;
    try {
      res = await fetchImpl(url, { headers: { authorization: `Basic ${auth}`, accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
    } catch (e) {
      throw new IntegrationError(`Could not reach the SimpleFIN Bridge (${(e as Error).message}).`, "feed_unreachable");
    }
    if (res.status === 403 || res.status === 401) throw new IntegrationError("SimpleFIN refused the stored access. Reconnect with a new setup token.", "feed_auth");
    if (!res.ok) throw new IntegrationError(`SimpleFIN answered ${res.status}.`, "feed_error");
    const body = (await res.json()) as { accounts?: SfAccount[]; errors?: string[] };
    return mapSimplefinAccounts(body);
  },
};
