/**
 * Depreciation schedules (docs/accounting/fixed-assets.md). Pure and exact.
 *
 * Conventions:
 *  - Monthly. A full month is taken in the month the asset is placed in
 *    service; none in the month it is disposed of.
 *  - Depreciable base = cost − residual value; accumulated depreciation never
 *    exceeds it, and the life's last month takes exactly what remains.
 *  - Straight line: each month = (base − accumulated) ÷ months remaining,
 *    rounded half-up to the currency. Computing from what remains each month
 *    means a change of estimate (life, residual) applies prospectively.
 *  - Declining balance at factor f: each month = (cost − accumulated) × f ÷
 *    life in months, rounded half-up, switching to straight line on what
 *    remains when that is larger, never below the residual value.
 *  - Method "none" (land) never depreciates.
 */
import { Decimal, type DecimalInput } from "@/lib/money/decimal";
import { minorUnits } from "@/lib/money/currency";
import { addMonths, endOfMonth, startOfMonth } from "@/lib/dates";

export interface ScheduleInput {
  cost: DecimalInput;
  residualValue: DecimalInput;
  usefulLifeMonths: number;
  method: "straight_line" | "declining_balance" | "none";
  decliningFactor?: DecimalInput | null;
  inServiceDate: string;
  currency: string;
}

export interface ScheduleState {
  /** Depreciation taken so far (posted runs plus any opening accumulated depreciation). */
  accumulated: DecimalInput;
  /** Months of life already used (0 = the in-service month is next). */
  monthsUsed: number;
}

export interface ScheduleRow {
  /** 0-based month of life. */
  index: number;
  periodEnd: string;
  amount: Decimal;
  accumulated: Decimal;
  netBookValue: Decimal;
}

/** The month-end of the n-th month of life (0 = the in-service month). */
export function monthEnd(inServiceDate: string, index: number): string {
  return endOfMonth(addMonths(startOfMonth(inServiceDate), index));
}

/** Months of life up to and including the month containing `date` (0 if before service). */
export function monthsThrough(inServiceDate: string, date: string): number {
  const a = startOfMonth(inServiceDate);
  const b = startOfMonth(date);
  if (b < a) return 0;
  const [ay, am] = a.split("-").map(Number) as [number, number];
  const [by, bm] = b.split("-").map(Number) as [number, number];
  return (by - ay) * 12 + (bm - am) + 1;
}

/** The remaining schedule from `state`, month by month to the end of the life. */
export function computeSchedule(input: ScheduleInput, state: ScheduleState = { accumulated: "0", monthsUsed: 0 }): ScheduleRow[] {
  const mu = minorUnits(input.currency);
  const cost = Decimal.from(input.cost).rescale(Math.max(mu, Decimal.from(input.cost).scale));
  const residual = Decimal.from(input.residualValue);
  const base = cost.sub(residual);
  const life = input.usefulLifeMonths;
  if (input.method === "none" || life <= 0 || !base.isPositive()) return [];
  let acc = Decimal.from(state.accumulated);
  const factor = Decimal.from(input.decliningFactor ?? "2");
  const rows: ScheduleRow[] = [];
  for (let i = Math.max(0, state.monthsUsed); i < life; i++) {
    const remaining = base.sub(acc);
    if (!remaining.isPositive()) break;
    const monthsLeft = life - i;
    let amount: Decimal;
    if (monthsLeft === 1) {
      amount = remaining;
    } else {
      const sl = remaining.div(monthsLeft, mu, "half_up");
      if (input.method === "declining_balance") {
        const db = cost.sub(acc).mul(factor).div(life, mu, "half_up");
        amount = Decimal.max(db, sl);
      } else {
        amount = sl;
      }
      if (amount.gt(remaining)) amount = remaining;
    }
    amount = amount.round(mu, "half_up");
    acc = acc.add(amount);
    rows.push({ index: i, periodEnd: monthEnd(input.inServiceDate, i), amount, accumulated: acc, netBookValue: cost.sub(acc) });
  }
  return rows;
}

/** Depreciation for the months ending in [from, to] from a schedule (for tax years and reports). */
export function sumBetween(rows: ScheduleRow[], from: string, to: string): Decimal {
  return Decimal.sum(rows.filter((r) => r.periodEnd >= from && r.periodEnd <= to).map((r) => r.amount));
}
