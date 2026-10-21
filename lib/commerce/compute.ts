/**
 * Document arithmetic: line amounts, line and document discounts, tax, and
 * totals. Pure and isomorphic — the form in the browser shows exactly what
 * the server will post, because both run this.
 *
 * Order of operations (docs/accounting/rounding.md):
 *  1. extended = quantity × unit price, rounded half-up to the currency;
 *  2. line discount = extended × line discount rate, rounded; amount = extended − discount;
 *  3. a document discount (percent or amount) is spread over the item lines
 *     (not shipping) in proportion to their amounts, by largest remainder;
 *  4. tax is computed on what remains (lib/tax/calculate.ts);
 *  5. totals are sums of the rounded line figures, so they always foot.
 */
import { Decimal, type DecimalInput } from "@/lib/money/decimal";
import { minorUnits } from "@/lib/money/currency";
import { calculateTaxes, type TaxComponent } from "@/lib/tax/calculate";

export interface ComputeLineInput {
  key: string;
  lineType?: "item" | "shipping";
  quantity: DecimalInput;
  unitPrice: DecimalInput;
  /** Fraction 0–1. */
  discountRate?: DecimalInput | null;
  taxComponents: TaxComponent[];
  exempt?: boolean;
}

export interface ComputeInput {
  currency: string;
  taxInclusive: boolean;
  rounding: "line" | "document";
  discountType?: "percent" | "amount" | null;
  /** Percent as a number of percent (10 = 10%), or an amount. */
  discountValue?: DecimalInput | null;
  lines: ComputeLineInput[];
}

export interface ComputedLine {
  key: string;
  extended: Decimal;
  lineDiscount: Decimal;
  /** After the line discount, before the document discount. Gross if tax-inclusive. */
  amount: Decimal;
  documentDiscount: Decimal;
  net: Decimal;
  tax: Decimal;
  gross: Decimal;
  taxes: { component: TaxComponent; taxable: Decimal; amount: Decimal; exempt: boolean }[];
}

export interface ComputedDocument {
  lines: ComputedLine[];
  subtotal: Decimal;
  discountTotal: Decimal;
  taxTotal: Decimal;
  total: Decimal;
  /** Net (excluding tax) total. */
  netTotal: Decimal;
}

export class ComputeError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
  }
}

export function computeDocument(input: ComputeInput): ComputedDocument {
  const mu = minorUnits(input.currency);
  const zero = Decimal.ZERO.rescale(mu);

  const prelim = input.lines.map((l, i) => {
    const q = Decimal.from(l.quantity);
    const p = Decimal.from(l.unitPrice);
    if (q.decimalPlaces > 6) throw new ComputeError(`Line ${i + 1}: quantity has more than 6 decimal places.`, `lines.${i}.quantity`);
    if (p.decimalPlaces > 8) throw new ComputeError(`Line ${i + 1}: price has more than 8 decimal places.`, `lines.${i}.unitPrice`);
    const extended = q.mul(p).round(mu, "half_up");
    let lineDiscount = zero;
    if (l.discountRate !== null && l.discountRate !== undefined && l.discountRate !== "") {
      const r = Decimal.from(l.discountRate);
      if (r.isNegative() || r.gt(1)) throw new ComputeError(`Line ${i + 1}: discount must be between 0% and 100%.`, `lines.${i}.discountRate`);
      lineDiscount = extended.mul(r).round(mu, "half_up");
    }
    return { l, extended, lineDiscount, amount: extended.sub(lineDiscount).rescale(mu) };
  });

  // Document-level discount over item lines.
  const itemIdx = prelim.map((p, i) => (p.l.lineType === "shipping" ? -1 : i)).filter((i) => i >= 0);
  const discountBase = Decimal.sum(itemIdx.map((i) => prelim[i]!.amount));
  let docDiscount = zero;
  if (input.discountType && input.discountValue !== null && input.discountValue !== undefined && input.discountValue !== "") {
    const v = Decimal.from(input.discountValue);
    if (v.isNegative()) throw new ComputeError("The discount cannot be negative.", "discountValue");
    if (input.discountType === "percent") {
      if (v.gt(100)) throw new ComputeError("The discount cannot exceed 100%.", "discountValue");
      docDiscount = discountBase.mul(v).div(100, mu, "half_up");
    } else {
      if (v.decimalPlaces > mu) throw new ComputeError(`The discount has more than ${mu} decimal places.`, "discountValue");
      docDiscount = v.rescale(mu);
    }
    if (docDiscount.gt(discountBase.abs()) && !docDiscount.isZero()) throw new ComputeError("The discount is more than the items it applies to.", "discountValue");
  }
  const shares: Decimal[] = prelim.map(() => zero);
  if (!docDiscount.isZero() && itemIdx.length) {
    const weights = itemIdx.map((i) => prelim[i]!.amount.abs());
    const parts = docDiscount.allocate(weights, mu);
    itemIdx.forEach((idx, k) => {
      shares[idx] = prelim[idx]!.amount.isNegative() ? parts[k]!.neg() : parts[k]!;
    });
  }

  const taxed = calculateTaxes(
    prelim.map((p, i) => ({
      key: p.l.key,
      amount: p.amount.sub(shares[i]!).rescale(mu),
      components: p.l.taxComponents,
      exempt: !!p.l.exempt,
    })),
    { currency: input.currency, inclusive: input.taxInclusive, rounding: input.taxInclusive ? "line" : input.rounding },
  );

  const lines: ComputedLine[] = prelim.map((p, i) => {
    const t = taxed[i]!;
    return {
      key: p.l.key,
      extended: p.extended,
      lineDiscount: p.lineDiscount,
      amount: p.amount,
      documentDiscount: shares[i]!,
      net: t.net,
      tax: t.tax,
      gross: t.gross,
      taxes: t.taxes,
    };
  });
  const subtotal = Decimal.sum(lines.map((l) => l.amount)).rescale(mu);
  const discountTotal = Decimal.sum(lines.map((l) => l.documentDiscount)).rescale(mu);
  const taxTotal = Decimal.sum(lines.map((l) => l.tax)).rescale(mu);
  const netTotal = Decimal.sum(lines.map((l) => l.net)).rescale(mu);
  const total = netTotal.add(taxTotal).rescale(mu);
  return { lines, subtotal, discountTotal, taxTotal, total, netTotal };
}
