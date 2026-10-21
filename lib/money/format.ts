/**
 * Display formatting for money, quantities and dates. Formatting never feeds
 * back into arithmetic. Amounts are passed to Intl as strings, which formats
 * them exactly (no conversion through a binary float).
 */
import { Decimal, type DecimalInput } from "./decimal";
import { CURRENCIES } from "./currency";

type IntlFormatArg = Parameters<Intl.NumberFormat["format"]>[0];

const cache = new Map<string, Intl.NumberFormat>();
function nf(key: string, make: () => Intl.NumberFormat): Intl.NumberFormat {
  let f = cache.get(key);
  if (!f) {
    f = make();
    cache.set(key, f);
  }
  return f;
}

export interface MoneyFormatOptions {
  /** Show negatives as (1,234.00). Default true — the accounting convention. */
  accounting?: boolean;
  /** Include the currency symbol/code. Default true. */
  symbol?: boolean;
  locale?: string;
}

export function formatMoney(
  amount: DecimalInput | null | undefined,
  currency: string,
  opts: MoneyFormatOptions = {},
): string {
  if (amount === null || amount === undefined || amount === "") return "";
  const d = Decimal.from(amount);
  const mu = CURRENCIES.get(currency)?.minorUnits ?? 2;
  const accounting = opts.accounting ?? true;
  const symbol = opts.symbol ?? true;
  const locale = opts.locale ?? "en-US";
  const key = `${locale}|${currency}|${mu}|${accounting}|${symbol}`;
  const f = nf(key, () =>
    new Intl.NumberFormat(locale, {
      style: symbol ? "currency" : "decimal",
      ...(symbol ? { currency, currencySign: accounting ? "accounting" : "standard" } : {}),
      minimumFractionDigits: mu,
      maximumFractionDigits: Math.max(mu, d.scale),
    }),
  );
  if (!symbol && accounting && d.isNegative()) {
    return `(${f.format(d.abs().toString() as unknown as IntlFormatArg)})`;
  }
  return f.format(d.toString() as unknown as IntlFormatArg);
}

/** A plain number with grouping, at least `minPlaces` decimals. */
export function formatNumber(v: DecimalInput | null | undefined, minPlaces = 0, locale = "en-US"): string {
  if (v === null || v === undefined || v === "") return "";
  const d = Decimal.from(v);
  const f = nf(`n|${locale}|${minPlaces}|${d.scale}`, () =>
    new Intl.NumberFormat(locale, { minimumFractionDigits: minPlaces, maximumFractionDigits: Math.max(minPlaces, d.scale) }),
  );
  return f.format(d.normalize().toString() as unknown as IntlFormatArg);
}

/** Quantity: up to the stored precision, trailing zeros dropped. */
export function formatQuantity(v: DecimalInput | null | undefined): string {
  if (v === null || v === undefined || v === "") return "";
  return formatNumber(Decimal.from(v).normalize());
}

/** Percent rate stored as a decimal fraction ("0.0725") shown as "7.25%". */
export function formatRatePercent(rate: DecimalInput): string {
  const pct = Decimal.from(rate).mul(100).normalize();
  return `${pct.toString()}%`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** ISO date (YYYY-MM-DD) as "Mar 5, 2026". Dates are calendar dates, never shifted by time zone. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

export function formatDateTime(ts: Date | string | null | undefined, timeZone = "UTC"): string {
  if (!ts) return "";
  const d = typeof ts === "string" ? new Date(ts) : ts;
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(d);
}
