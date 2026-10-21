/** Providers count money in minor units (cents); the books count in decimals. */
import { Decimal } from "@/lib/money/decimal";
import { isCurrency, minorUnits } from "@/lib/money/currency";

export function fromMinor(amountMinor: number, currency: string): Decimal {
  const cur = currency.toUpperCase();
  if (!isCurrency(cur)) throw new Error(`unknown currency ${currency}`);
  if (!Number.isSafeInteger(amountMinor)) throw new Error("amount is not an integer number of minor units");
  return Decimal.of(BigInt(amountMinor), minorUnits(cur));
}

export function toMinor(amount: Decimal, currency: string): number {
  const mu = minorUnits(currency.toUpperCase());
  const units = amount.rescale(mu).units;
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("amount too large");
  return Number(units);
}
