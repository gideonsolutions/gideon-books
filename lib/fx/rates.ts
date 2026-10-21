/**
 * Exchange rates: entered by hand or fetched from a provider, stored as
 * rows with their source, never edited once a posting has used them. A
 * posting copies the rate value it used and keeps this row's id as
 * provenance, so later rate changes cannot alter history.
 *
 * Lookup: the rate for a currency on a date is the latest rate dated on or
 * before it, preferring a manual rate over a fetched one on the same day
 * (rates typed on a single transaction are used only by that transaction),
 * and no older than `maxAgeDays` (default 7) — a stale rate is refused
 * rather than silently used.
 */
import { and, desc, eq, lte, sql, gte } from "drizzle-orm";
import { withTransaction, type DbOrTx } from "@/lib/db/client";
import { exchangeRates, journalLines } from "@/lib/db/schema/ledger";
import { audit } from "@/lib/audit";
import { requirePermission, type Ctx } from "@/lib/context";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { Decimal, type DecimalInput } from "@/lib/money/decimal";
import { isCurrency, minorUnits } from "@/lib/money/currency";
import { addDays, assertIsoDate } from "@/lib/dates";

export type ExchangeRate = typeof exchangeRates.$inferSelect;

export interface ResolvedRate {
  rate: Decimal;
  exchangeRateId: string | null;
  rateDate: string;
  source: string;
}

export class MissingRateError extends ValidationError {
  constructor(currency: string, base: string, date: string) {
    super(
      `There is no ${currency}→${base} exchange rate on or within a week before ${date}. Enter one under Settings → Currencies, or fetch rates from the provider.`,
      { fxRate: "Exchange rate required." },
      { currency, base, date },
    );
  }
}

export async function findRate(
  db: DbOrTx,
  orgId: string,
  currency: string,
  baseCurrency: string,
  date: string,
  maxAgeDays = 7,
): Promise<ResolvedRate | null> {
  if (currency === baseCurrency) return { rate: Decimal.ONE, exchangeRateId: null, rateDate: date, source: "identity" };
  const rows = await db
    .select()
    .from(exchangeRates)
    .where(
      and(
        eq(exchangeRates.orgId, orgId),
        eq(exchangeRates.currency, currency),
        eq(exchangeRates.baseCurrency, baseCurrency),
        lte(exchangeRates.rateDate, date),
        gte(exchangeRates.rateDate, addDays(date, -maxAgeDays)),
        sql`${exchangeRates.source} <> 'transaction'`,
      ),
    )
    .orderBy(desc(exchangeRates.rateDate), sql`case when ${exchangeRates.source} = 'manual' then 0 else 1 end`, desc(exchangeRates.createdAt))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return { rate: Decimal.from(r.rate), exchangeRateId: r.id, rateDate: r.rateDate, source: r.source };
}

export async function requireRate(db: DbOrTx, orgId: string, currency: string, baseCurrency: string, date: string): Promise<ResolvedRate> {
  const r = await findRate(db, orgId, currency, baseCurrency, date);
  if (!r) throw new MissingRateError(currency, baseCurrency, date);
  return r;
}

/**
 * The rate to use for a document or payment: the one the person typed (kept
 * as a manual rate row so its provenance is recorded) or the stored rate.
 */
export async function resolveRate(
  db: DbOrTx,
  ctx: Ctx,
  currency: string,
  date: string,
  typed?: DecimalInput | null,
): Promise<ResolvedRate> {
  const base = ctx.org.baseCurrency;
  if (currency === base) return { rate: Decimal.ONE, exchangeRateId: null, rateDate: date, source: "identity" };
  if (typed !== undefined && typed !== null && typed !== "") {
    const rate = Decimal.from(typed);
    if (!rate.isPositive()) throw new ValidationError("The exchange rate must be positive.", { fxRate: "Must be positive." });
    const stored = await findRate(db, ctx.orgId, currency, base, date, 7);
    if (stored && stored.rate.eq(rate)) return stored;
    // A typed rate becomes a manual rate row dated the transaction date, with
    // the person who typed it, so the posting can name where it came from.
    const [row] = await db
      .insert(exchangeRates)
      .values({
        orgId: ctx.orgId,
        currency,
        baseCurrency: base,
        rateDate: date,
        rate: rate.round(12, "half_up").toString(),
        source: "transaction",
        sourceRef: "entered on transaction",
        createdBy: ctx.actor.userId,
      })
      .returning();
    return { rate, exchangeRateId: row!.id, rateDate: date, source: row!.source };
  }
  return requireRate(db, ctx.orgId, currency, base, date);
}

export async function listRates(db: DbOrTx, orgId: string, opts: { currency?: string; limit?: number } = {}) {
  const conds = [eq(exchangeRates.orgId, orgId)];
  if (opts.currency) conds.push(eq(exchangeRates.currency, opts.currency));
  return db
    .select()
    .from(exchangeRates)
    .where(and(...conds))
    .orderBy(desc(exchangeRates.rateDate), exchangeRates.currency)
    .limit(opts.limit ?? 200);
}

export async function addManualRate(ctx: Ctx, input: { currency: string; rateDate: string; rate: string; note?: string | null }): Promise<ExchangeRate> {
  requirePermission(ctx, "fx.manage");
  assertIsoDate(input.rateDate, "rate date");
  if (!isCurrency(input.currency)) throw new ValidationError("Unknown currency.", { currency: "Pick a currency." });
  if (input.currency === ctx.org.baseCurrency) throw new ValidationError("That is the base currency.", { currency: "Pick a foreign currency." });
  const rate = Decimal.tryFrom(input.rate.trim());
  if (!rate || !rate.isPositive()) throw new ValidationError("Enter a positive rate.", { rate: `${ctx.org.baseCurrency} per 1 ${input.currency}.` });
  if (rate.decimalPlaces > 12) throw new ValidationError("Use at most 12 decimal places.", { rate: "Too precise." });
  return withTransaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(exchangeRates)
      .where(
        and(
          eq(exchangeRates.orgId, ctx.orgId),
          eq(exchangeRates.currency, input.currency),
          eq(exchangeRates.rateDate, input.rateDate),
          eq(exchangeRates.source, "manual"),
        ),
      );
    if (existing) {
      const [used] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(journalLines)
        .where(and(eq(journalLines.orgId, ctx.orgId), eq(journalLines.exchangeRateId, existing.id)));
      if ((used?.n ?? 0) > 0) {
        throw new ConflictError(
          "A manual rate for that day is already used by postings, so it cannot change. Postings keep the rate they used; new postings can use a typed rate.",
          "rate_in_use",
        );
      }
      const [row] = await tx
        .update(exchangeRates)
        .set({ rate: rate.toString(), sourceRef: input.note ?? null, createdBy: ctx.actor.userId })
        .where(eq(exchangeRates.id, existing.id))
        .returning();
      await audit(tx, ctx, { action: "fx.rate_updated", entityType: "exchange_rate", entityId: existing.id, before: existing, after: row });
      return row!;
    }
    const [row] = await tx
      .insert(exchangeRates)
      .values({
        orgId: ctx.orgId,
        currency: input.currency,
        baseCurrency: ctx.org.baseCurrency,
        rateDate: input.rateDate,
        rate: rate.toString(),
        source: "manual",
        sourceRef: input.note ?? null,
        createdBy: ctx.actor.userId,
      })
      .returning();
    await audit(tx, ctx, { action: "fx.rate_added", entityType: "exchange_rate", entityId: row!.id, after: row });
    return row!;
  });
}

export async function deleteRate(ctx: Ctx, rateId: string): Promise<void> {
  requirePermission(ctx, "fx.manage");
  await withTransaction(async (tx) => {
    const [r] = await tx.select().from(exchangeRates).where(and(eq(exchangeRates.orgId, ctx.orgId), eq(exchangeRates.id, rateId)));
    if (!r) throw new NotFoundError("The rate");
    const [used] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(journalLines)
      .where(and(eq(journalLines.orgId, ctx.orgId), eq(journalLines.exchangeRateId, rateId)));
    if ((used?.n ?? 0) > 0) throw new ConflictError("Postings used this rate; it stays as their provenance.", "rate_in_use");
    await tx.delete(exchangeRates).where(eq(exchangeRates.id, rateId));
    await audit(tx, ctx, { action: "fx.rate_deleted", entityType: "exchange_rate", entityId: rateId, before: r });
  });
}

/** Convert a foreign amount to base at `rate`, rounded half-up to the base currency's minor units. */
export function toBase(amount: DecimalInput, rate: DecimalInput, baseCurrency: string): Decimal {
  return Decimal.from(amount).mul(rate).round(minorUnits(baseCurrency), "half_up");
}
