/**
 * Exact decimal arithmetic for accounting.
 *
 * A Decimal is an integer number of units at a scale: 12.34 is 1234 at scale 2.
 * Addition, subtraction and multiplication are exact. Division and any change
 * to a smaller scale take an explicit rounding mode, so no figure is ever
 * rounded without the caller saying how. JavaScript numbers are refused except
 * for safe integers: a binary float never enters a calculation.
 *
 * Isomorphic (no Node APIs), so forms in the browser compute the same totals
 * the server posts.
 */

export type RoundingMode =
  /** Round half away from zero (commercial rounding): 2.345 → 2.35, -2.345 → -2.35. */
  | "half_up"
  /** Round half to even (banker's rounding): 2.345 → 2.34, 2.355 → 2.36. */
  | "half_even"
  /** Toward zero (truncate). */
  | "down"
  /** Away from zero. */
  | "up"
  /** Toward negative infinity. */
  | "floor"
  /** Toward positive infinity. */
  | "ceiling";

const DECIMAL_RE = /^([+-])?(\d+)(?:\.(\d+))?$/;
const MAX_SCALE = 30;

const pow10Cache: bigint[] = [];
function pow10(n: number): bigint {
  if (n < 0) throw new RangeError("negative exponent");
  let v = pow10Cache[n];
  if (v === undefined) {
    v = 10n ** BigInt(n);
    pow10Cache[n] = v;
  }
  return v;
}

function absBig(v: bigint): bigint {
  return v < 0n ? -v : v;
}

/** Divide integers with an explicit rounding mode. */
function divRound(num: bigint, den: bigint, mode: RoundingMode): bigint {
  if (den === 0n) throw new RangeError("division by zero");
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const q = num / den; // truncates toward zero
  const r = num % den;
  if (r === 0n) return q;
  const negative = num < 0n;
  const twiceR = absBig(r) * 2n;
  switch (mode) {
    case "down":
      return q;
    case "up":
      return negative ? q - 1n : q + 1n;
    case "floor":
      return negative ? q - 1n : q;
    case "ceiling":
      return negative ? q : q + 1n;
    case "half_up":
      if (twiceR >= den) return negative ? q - 1n : q + 1n;
      return q;
    case "half_even": {
      if (twiceR > den) return negative ? q - 1n : q + 1n;
      if (twiceR < den) return q;
      const odd = absBig(q) % 2n === 1n;
      if (!odd) return q;
      return negative ? q - 1n : q + 1n;
    }
  }
}

export type DecimalInput = Decimal | string | bigint | number;

export class Decimal {
  /** value = units / 10^scale */
  readonly units: bigint;
  readonly scale: number;

  private constructor(units: bigint, scale: number) {
    if (!Number.isInteger(scale) || scale < 0 || scale > MAX_SCALE) {
      throw new RangeError(`invalid scale ${scale}`);
    }
    this.units = units;
    this.scale = scale;
  }

  static readonly ZERO = new Decimal(0n, 0);
  static readonly ONE = new Decimal(1n, 0);

  static of(units: bigint, scale: number): Decimal {
    return new Decimal(units, scale);
  }

  /**
   * Parse a canonical decimal string ("-1234.5600"), a bigint, a safe integer,
   * or another Decimal. Non-integer JavaScript numbers are refused.
   */
  static from(v: DecimalInput): Decimal {
    if (v instanceof Decimal) return v;
    if (typeof v === "bigint") return new Decimal(v, 0);
    if (typeof v === "number") {
      if (!Number.isSafeInteger(v)) {
        throw new TypeError(
          `Decimal.from refuses the non-integer or unsafe number ${v}; pass a string`,
        );
      }
      return new Decimal(BigInt(v), 0);
    }
    if (typeof v !== "string") throw new TypeError("Decimal.from expects a string, bigint or Decimal");
    const m = DECIMAL_RE.exec(v.trim());
    if (!m) throw new SyntaxError(`not a decimal number: ${JSON.stringify(v)}`);
    const [, sign, intPart, fracPart = ""] = m;
    if (fracPart.length > MAX_SCALE) throw new RangeError(`too many decimal places: ${v}`);
    let units = BigInt(intPart + fracPart);
    if (sign === "-") units = -units;
    return new Decimal(units, fracPart.length);
  }

  /** Parse, returning null instead of throwing. */
  static tryFrom(v: unknown): Decimal | null {
    if (v === null || v === undefined || v === "") return null;
    try {
      return Decimal.from(v as DecimalInput);
    } catch {
      return null;
    }
  }

  static isValid(v: string): boolean {
    return DECIMAL_RE.test(v.trim());
  }

  static sum(values: Iterable<DecimalInput>): Decimal {
    let acc: Decimal = Decimal.ZERO;
    for (const v of values) acc = acc.add(v);
    return acc;
  }

  static max(a: DecimalInput, b: DecimalInput): Decimal {
    const da = Decimal.from(a);
    const db = Decimal.from(b);
    return da.cmp(db) >= 0 ? da : db;
  }

  static min(a: DecimalInput, b: DecimalInput): Decimal {
    const da = Decimal.from(a);
    const db = Decimal.from(b);
    return da.cmp(db) <= 0 ? da : db;
  }

  /** Units of this value at a larger (or equal) scale. */
  private unitsAt(scale: number): bigint {
    if (scale < this.scale) throw new RangeError("unitsAt cannot reduce scale");
    return this.units * pow10(scale - this.scale);
  }

  add(other: DecimalInput): Decimal {
    const o = Decimal.from(other);
    const s = Math.max(this.scale, o.scale);
    return new Decimal(this.unitsAt(s) + o.unitsAt(s), s);
  }

  sub(other: DecimalInput): Decimal {
    const o = Decimal.from(other);
    const s = Math.max(this.scale, o.scale);
    return new Decimal(this.unitsAt(s) - o.unitsAt(s), s);
  }

  /** Exact product (scale is the sum of the scales, capped by normalizing trailing zeros). */
  mul(other: DecimalInput): Decimal {
    const o = Decimal.from(other);
    let units = this.units * o.units;
    let scale = this.scale + o.scale;
    while (scale > MAX_SCALE) {
      if (units % 10n !== 0n) throw new RangeError("product exceeds maximum precision");
      units /= 10n;
      scale -= 1;
    }
    return new Decimal(units, scale);
  }

  /** Quotient at `scale` decimal places, rounded with `mode`. */
  div(other: DecimalInput, scale: number, mode: RoundingMode): Decimal {
    const o = Decimal.from(other);
    if (o.units === 0n) throw new RangeError("division by zero");
    // (a/10^sa) / (b/10^sb) = a*10^(sb) / (b*10^sa); want result units at `scale`.
    const num = this.units * pow10(o.scale + scale);
    const den = o.units * pow10(this.scale);
    return new Decimal(divRound(num, den, mode), scale);
  }

  /** this × numerator ÷ denominator, rounded once at the end. */
  mulDiv(numerator: DecimalInput, denominator: DecimalInput, scale: number, mode: RoundingMode): Decimal {
    return this.mul(numerator).div(denominator, scale, mode);
  }

  round(scale: number, mode: RoundingMode): Decimal {
    if (scale >= this.scale) return new Decimal(this.unitsAt(scale), scale);
    return new Decimal(divRound(this.units, pow10(this.scale - scale), mode), scale);
  }

  /** Change scale without losing precision; throws if rounding would be needed. */
  rescale(scale: number): Decimal {
    if (scale >= this.scale) return new Decimal(this.unitsAt(scale), scale);
    const factor = pow10(this.scale - scale);
    if (this.units % factor !== 0n) {
      throw new RangeError(`${this.toString()} has more than ${scale} decimal places`);
    }
    return new Decimal(this.units / factor, scale);
  }

  /** Number of significant decimal places (ignoring trailing zeros). */
  get decimalPlaces(): number {
    return this.normalize().scale;
  }

  /** Same value with trailing fractional zeros removed. */
  normalize(): Decimal {
    let units = this.units;
    let scale = this.scale;
    while (scale > 0 && units % 10n === 0n) {
      units /= 10n;
      scale -= 1;
    }
    return new Decimal(units, scale);
  }

  neg(): Decimal {
    return new Decimal(-this.units, this.scale);
  }

  abs(): Decimal {
    return this.units < 0n ? this.neg() : this;
  }

  cmp(other: DecimalInput): -1 | 0 | 1 {
    const o = Decimal.from(other);
    const s = Math.max(this.scale, o.scale);
    const a = this.unitsAt(s);
    const b = o.unitsAt(s);
    return a < b ? -1 : a > b ? 1 : 0;
  }

  eq(other: DecimalInput): boolean {
    return this.cmp(other) === 0;
  }
  lt(other: DecimalInput): boolean {
    return this.cmp(other) < 0;
  }
  lte(other: DecimalInput): boolean {
    return this.cmp(other) <= 0;
  }
  gt(other: DecimalInput): boolean {
    return this.cmp(other) > 0;
  }
  gte(other: DecimalInput): boolean {
    return this.cmp(other) >= 0;
  }

  isZero(): boolean {
    return this.units === 0n;
  }
  isNegative(): boolean {
    return this.units < 0n;
  }
  isPositive(): boolean {
    return this.units > 0n;
  }
  sign(): -1 | 0 | 1 {
    return this.units < 0n ? -1 : this.units > 0n ? 1 : 0;
  }

  /**
   * Split this amount across `weights` so the parts sum exactly to this
   * amount at `scale` (largest-remainder method; ties go to the earliest
   * weight). Weights may be any non-negative decimals; if all are zero the
   * amount is split equally.
   */
  allocate(weights: DecimalInput[], scale: number): Decimal[] {
    if (weights.length === 0) throw new RangeError("allocate needs at least one weight");
    const total = this.rescale(Math.max(scale, this.scale)).round(scale, "half_up");
    if (!total.eq(this)) throw new RangeError(`${this.toString()} is not representable at scale ${scale}`);
    let ws = weights.map((w) => Decimal.from(w));
    if (ws.some((w) => w.isNegative())) throw new RangeError("allocate weights must be non-negative");
    let wsum = Decimal.sum(ws);
    if (wsum.isZero()) {
      ws = ws.map(() => Decimal.ONE);
      wsum = Decimal.from(ws.length);
    }
    const targetUnits = total.units;
    // Exact share of each part in units, as a rational: targetUnits * w / wsum.
    const ws_s = Math.max(...ws.map((w) => w.scale), wsum.scale);
    const wUnits = ws.map((w) => w.unitsAt(ws_s));
    const sumUnits = wsum.unitsAt(ws_s);
    const parts: bigint[] = [];
    const remainders: { i: number; r: bigint }[] = [];
    let allocated = 0n;
    for (let i = 0; i < wUnits.length; i++) {
      const num = targetUnits * wUnits[i]!;
      const q = num / sumUnits; // toward zero
      parts.push(q);
      allocated += q;
      remainders.push({ i, r: absBig(num % sumUnits) });
    }
    let left = targetUnits - allocated;
    const step = left < 0n ? -1n : 1n;
    remainders.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
    let k = 0;
    while (left !== 0n) {
      const idx = remainders[k % remainders.length]!.i;
      parts[idx] = parts[idx]! + step;
      left -= step;
      k++;
    }
    return parts.map((u) => new Decimal(u, scale));
  }

  /** Canonical string with exactly this value's scale ("12.30"). */
  toString(): string {
    const neg = this.units < 0n;
    const digits = absBig(this.units).toString();
    if (this.scale === 0) return (neg ? "-" : "") + digits;
    const padded = digits.padStart(this.scale + 1, "0");
    const i = padded.length - this.scale;
    return (neg ? "-" : "") + padded.slice(0, i) + "." + padded.slice(i);
  }

  /** String at exactly `scale` places; throws if that would need rounding. */
  toFixed(scale: number): string {
    return this.rescale(scale).toString();
  }

  toJSON(): string {
    return this.toString();
  }

  /** For display only (charts); never feed the result back into arithmetic. */
  toNumberForDisplay(): number {
    return Number(this.toString());
  }
}

export const D = Decimal.from;
