/**
 * Exchange-rate providers. The default is the European Central Bank's
 * published reference rates (free, no key, about 30 currencies, business
 * days only). Rates are stored with the provider's name and the publication
 * they came from; a fetched rate is never overwritten.
 *
 * Configure with FX_PROVIDER=ecb (default) or FX_PROVIDER=none (manual rates
 * only). Set FX_ECB_BASE_URL to use a mirror.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, withTransaction } from "@/lib/db/client";
import { exchangeRates } from "@/lib/db/schema/ledger";
import { audit } from "@/lib/audit";
import { requirePermission, type Ctx } from "@/lib/context";
import { IntegrationError, ValidationError } from "@/lib/errors";
import { Decimal } from "@/lib/money/decimal";
import { isCurrency } from "@/lib/money/currency";

export interface FetchedRate {
  currency: string;
  date: string;
  /** Base-currency units per one unit of `currency`. */
  rate: Decimal;
  sourceRef: string;
}

export interface FxProvider {
  name: string;
  label: string;
  fetchRates(args: { base: string; currencies: string[]; from: string; to: string }): Promise<FetchedRate[]>;
}

/** Parse the ECB eurofxref XML into { date → { currency → units per EUR } }. */
export function parseEcbXml(xml: string): Map<string, Map<string, Decimal>> {
  const out = new Map<string, Map<string, Decimal>>();
  const dayRe = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]\s*>([\s\S]*?)<\/Cube>/g;
  const rateRe = /<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9.]+)['"]\s*\/>/g;
  for (const m of xml.matchAll(dayRe)) {
    const date = m[1]!;
    const rates = new Map<string, Decimal>();
    for (const r of m[2]!.matchAll(rateRe)) {
      const d = Decimal.tryFrom(r[2]!);
      if (d && d.isPositive()) rates.set(r[1]!, d);
    }
    rates.set("EUR", Decimal.ONE);
    out.set(date, rates);
  }
  return out;
}

/** Cross rate: base units per one `currency`, from per-EUR quotes. */
export function ecbCross(perEur: Map<string, Decimal>, base: string, currency: string): Decimal | null {
  const b = perEur.get(base);
  const c = perEur.get(currency);
  if (!b || !c) return null;
  return b.div(c, 10, "half_up");
}

export const ecbProvider: FxProvider = {
  name: "ecb",
  label: "European Central Bank reference rates",
  async fetchRates({ base, currencies, from, to }) {
    const root = process.env.FX_ECB_BASE_URL ?? "https://www.ecb.europa.eu/stats/eurofxref";
    // The 90-day file covers recent dates; older ranges need the full history.
    const ninetyDaysAgo = new Date(Date.now() - 88 * 86_400_000).toISOString().slice(0, 10);
    const file = from >= ninetyDaysAgo ? "eurofxref-hist-90d.xml" : "eurofxref-hist.xml";
    const url = `${root}/${file}`;
    let res: Response;
    try {
      res = await fetch(url, { headers: { accept: "application/xml" }, signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      throw new IntegrationError(`Could not reach the ECB rate service (${(e as Error).message}).`, "fx_provider_unreachable");
    }
    if (!res.ok) throw new IntegrationError(`The ECB rate service answered ${res.status}.`, "fx_provider_error");
    const days = parseEcbXml(await res.text());
    const out: FetchedRate[] = [];
    for (const [date, perEur] of days) {
      if (date < from || date > to) continue;
      for (const cur of currencies) {
        if (cur === base) continue;
        const rate = ecbCross(perEur, base, cur);
        if (rate) out.push({ currency: cur, date, rate, sourceRef: `${url}#${date}` });
      }
    }
    return out;
  },
};

export function configuredProvider(): FxProvider | null {
  const name = (process.env.FX_PROVIDER ?? "ecb").toLowerCase();
  if (name === "none" || name === "manual") return null;
  if (name === "ecb") return ecbProvider;
  throw new Error(`Unknown FX_PROVIDER "${name}"`);
}

/** Currencies the organization has used (or holds accounts in). */
export async function currenciesInUse(orgId: string, base: string): Promise<string[]> {
  const res = await getDb().execute<{ c: string }>(sql`
    select distinct c from (
      select currency as c from contacts where org_id = ${orgId} and currency is not null
      union select currency from accounts where org_id = ${orgId} and currency is not null
      union select currency from documents where org_id = ${orgId}
      union select currency from payments where org_id = ${orgId}
    ) x where c <> ${base}
  `);
  return res.rows.map((r) => r.c).filter(isCurrency);
}

/** Fetch rates from the configured provider into the organization's rate table. */
export async function fetchRates(ctx: Ctx, args: { from: string; to: string; currencies?: string[] }, provider: FxProvider | null = configuredProvider()) {
  requirePermission(ctx, "fx.manage");
  if (ctx.org.isDemo && provider && provider.name !== "ecb") throw new ValidationError("Demonstration companies use public rates only.");
  if (!provider) throw new ValidationError("No exchange-rate provider is configured (FX_PROVIDER=none). Enter rates by hand.");
  const currencies = args.currencies?.length ? args.currencies : await currenciesInUse(ctx.orgId, ctx.org.baseCurrency);
  if (!currencies.length) return { inserted: 0, fetched: 0, currencies };
  const fetched = await provider.fetchRates({ base: ctx.org.baseCurrency, currencies, from: args.from, to: args.to });
  if (!fetched.length) return { inserted: 0, fetched: 0, currencies };
  return withTransaction(async (tx) => {
    const existing = await tx
      .select({ currency: exchangeRates.currency, rateDate: exchangeRates.rateDate })
      .from(exchangeRates)
      .where(and(eq(exchangeRates.orgId, ctx.orgId), eq(exchangeRates.source, provider.name), inArray(exchangeRates.currency, currencies)));
    const have = new Set(existing.map((e) => `${e.currency}|${e.rateDate}`));
    const rows = fetched
      .filter((f) => !have.has(`${f.currency}|${f.date}`))
      .map((f) => ({
        orgId: ctx.orgId,
        currency: f.currency,
        baseCurrency: ctx.org.baseCurrency,
        rateDate: f.date,
        rate: f.rate.toString(),
        source: provider.name,
        sourceRef: f.sourceRef,
        fetchedAt: new Date(),
      }));
    if (rows.length) await tx.insert(exchangeRates).values(rows).onConflictDoNothing();
    await audit(tx, ctx, { action: "fx.rates_fetched", entityType: "exchange_rate", metadata: { provider: provider.name, from: args.from, to: args.to, inserted: rows.length, currencies } });
    return { inserted: rows.length, fetched: fetched.length, currencies };
  });
}
