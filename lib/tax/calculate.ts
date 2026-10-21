/**
 * Sales-tax arithmetic. Pure: no database, so the same function computes a
 * document in the browser and on the server, and the tests pin it exactly.
 *
 * Rules (docs/accounting/sales-tax.md):
 *  - A tax code applies its components in sequence. A simple component taxes
 *    the line's net amount; a compound component taxes the net plus the
 *    taxes before it.
 *  - Exclusive pricing: tax is added to the net. Each line's tax per
 *    component is rounded half-up to the currency's minor units ("line"
 *    rounding), or the unrounded taxes are summed per component across the
 *    document and rounded once, then spread back over the lines by largest
 *    remainder ("document" rounding).
 *  - Inclusive pricing: the line amount is the gross. Net = gross ÷ (1 + the
 *    code's effective rate), rounded; taxes are then computed on the net and
 *    any rounding difference is absorbed by the net, so the gross the customer
 *    sees is exactly what they pay. Inclusive documents always round per line.
 *  - Exempt lines (an exempt customer or exempt code) record the base as
 *    exempt with zero tax.
 */
import { Decimal } from "@/lib/money/decimal";
import { minorUnits } from "@/lib/money/currency";

export interface TaxComponent {
  jurisdictionId: string;
  jurisdictionName?: string;
  taxRateId: string;
  /** Fraction: 0.0475 */
  rate: Decimal;
  sequence: number;
  isCompound: boolean;
  /** Liability account (sales) or recoverable account (purchases, when recoverable). */
  accountId: string | null;
  isRecoverable?: boolean;
}

export interface TaxLineInput {
  key: string;
  /** Exclusive: the net. Inclusive: the gross. */
  amount: Decimal;
  components: TaxComponent[];
  exempt: boolean;
}

export interface TaxLineResult {
  key: string;
  net: Decimal;
  tax: Decimal;
  gross: Decimal;
  taxes: { component: TaxComponent; taxable: Decimal; amount: Decimal; exempt: boolean }[];
}

const WORK_SCALE = 12;

function sorted(components: TaxComponent[]): TaxComponent[] {
  return [...components].sort((a, b) => a.sequence - b.sequence);
}

/** Unrounded taxes on `net` for each component, in sequence. */
function exactTaxes(net: Decimal, components: TaxComponent[]): { component: TaxComponent; taxable: Decimal; amount: Decimal }[] {
  const out: { component: TaxComponent; taxable: Decimal; amount: Decimal }[] = [];
  let prior = Decimal.ZERO;
  for (const c of sorted(components)) {
    const taxable = c.isCompound ? net.add(prior) : net;
    const amount = taxable.mul(c.rate);
    out.push({ component: c, taxable, amount });
    prior = prior.add(amount);
  }
  return out;
}

/** Rounded taxes on `net` per component (line rounding). Compound bases use the rounded prior taxes. */
function roundedTaxes(net: Decimal, components: TaxComponent[], mu: number) {
  const out: { component: TaxComponent; taxable: Decimal; amount: Decimal }[] = [];
  let prior = Decimal.ZERO;
  for (const c of sorted(components)) {
    const taxable = c.isCompound ? net.add(prior) : net;
    const amount = taxable.mul(c.rate).round(mu, "half_up");
    out.push({ component: c, taxable, amount });
    prior = prior.add(amount);
  }
  return out;
}

/** The multiplier M with gross = net × M for a code's components. */
export function inclusiveMultiplier(components: TaxComponent[]): Decimal {
  // tax_i = k_i × net, with k_i = r_i (simple) or r_i × (1 + Σ_{j<i} k_j) (compound).
  let sumK = Decimal.ZERO;
  for (const c of sorted(components)) {
    const k = c.isCompound ? c.rate.mul(Decimal.ONE.add(sumK)) : c.rate;
    sumK = sumK.add(k);
  }
  return Decimal.ONE.add(sumK);
}

export function calculateTaxes(
  lines: TaxLineInput[],
  opts: { currency: string; inclusive: boolean; rounding: "line" | "document" },
): TaxLineResult[] {
  const mu = minorUnits(opts.currency);
  for (const l of lines) {
    if (l.amount.decimalPlaces > mu) throw new RangeError(`line ${l.key}: amount has more than ${mu} decimal places`);
  }

  if (opts.inclusive) {
    return lines.map((l) => {
      const gross = l.amount.rescale(mu);
      if (l.exempt || l.components.length === 0) {
        return {
          key: l.key,
          net: gross,
          tax: Decimal.ZERO.rescale(mu),
          gross,
          taxes: sorted(l.components).map((c) => ({ component: c, taxable: gross, amount: Decimal.ZERO.rescale(mu), exempt: l.exempt })),
        };
      }
      const m = inclusiveMultiplier(l.components);
      let net = gross.div(m, mu, "half_up");
      const taxes = roundedTaxes(net, l.components, mu);
      const taxSum = Decimal.sum(taxes.map((t) => t.amount));
      // The net absorbs the rounding difference so net + tax = gross exactly.
      net = gross.sub(taxSum).rescale(mu);
      return { key: l.key, net, tax: taxSum.rescale(mu), gross, taxes: taxes.map((t) => ({ ...t, exempt: false })) };
    });
  }

  if (opts.rounding === "line") {
    return lines.map((l) => {
      const net = l.amount.rescale(mu);
      if (l.exempt || l.components.length === 0) {
        return {
          key: l.key,
          net,
          tax: Decimal.ZERO.rescale(mu),
          gross: net,
          taxes: sorted(l.components).map((c) => ({ component: c, taxable: net, amount: Decimal.ZERO.rescale(mu), exempt: l.exempt })),
        };
      }
      const taxes = roundedTaxes(net, l.components, mu);
      const tax = Decimal.sum(taxes.map((t) => t.amount)).rescale(mu);
      return { key: l.key, net, tax, gross: net.add(tax), taxes: taxes.map((t) => ({ ...t, exempt: false })) };
    });
  }

  // Document rounding: exact taxes summed per rate, rounded once, spread back.
  const exact = lines.map((l) => ({
    line: l,
    taxes: l.exempt ? [] : exactTaxes(l.amount.rescale(mu), l.components),
  }));
  const groups = new Map<string, { total: Decimal; members: { lineIdx: number; taxIdx: number; exact: Decimal }[] }>();
  exact.forEach((e, lineIdx) => {
    e.taxes.forEach((t, taxIdx) => {
      const key = `${t.component.taxRateId}|${t.component.sequence}|${t.component.isCompound}`;
      const g = groups.get(key) ?? { total: Decimal.ZERO, members: [] };
      g.total = g.total.add(t.amount);
      g.members.push({ lineIdx, taxIdx, exact: t.amount });
      groups.set(key, g);
    });
  });
  const rounded: Decimal[][] = exact.map((e) => e.taxes.map(() => Decimal.ZERO));
  for (const g of groups.values()) {
    const total = g.total.round(mu, "half_up");
    const weights = g.members.map((m) => m.exact.abs().round(WORK_SCALE, "half_up"));
    const parts = total.isNegative()
      ? total.neg().allocate(weights, mu).map((p) => p.neg())
      : total.allocate(weights, mu);
    g.members.forEach((m, i) => {
      rounded[m.lineIdx]![m.taxIdx] = parts[i]!;
    });
  }
  return exact.map((e, i) => {
    const net = e.line.amount.rescale(mu);
    if (e.line.exempt || e.line.components.length === 0) {
      return {
        key: e.line.key,
        net,
        tax: Decimal.ZERO.rescale(mu),
        gross: net,
        taxes: sorted(e.line.components).map((c) => ({ component: c, taxable: net, amount: Decimal.ZERO.rescale(mu), exempt: e.line.exempt })),
      };
    }
    const taxes = e.taxes.map((t, j) => ({ component: t.component, taxable: t.taxable.round(mu, "half_up"), amount: rounded[i]![j]!, exempt: false }));
    const tax = Decimal.sum(taxes.map((t) => t.amount)).rescale(mu);
    return { key: e.line.key, net, tax, gross: net.add(tax), taxes };
  });
}
