/**
 * Calendar dates as ISO strings (YYYY-MM-DD). Accounting dates are calendar
 * dates — a posting date has no time and no time zone — so they are never
 * held in a JavaScript Date, which would shift them across zones.
 */

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = ISO_DATE_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}

export function assertIsoDate(s: string, label = "date"): string {
  if (!isIsoDate(s)) throw new RangeError(`${label} must be a date (YYYY-MM-DD), got ${JSON.stringify(s)}`);
  return s;
}

export function parts(s: string): [number, number, number] {
  const m = ISO_DATE_RE.exec(s);
  if (!m) throw new RangeError(`not an ISO date: ${s}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function fromParts(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInMonth(y: number, m: number): number {
  return [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;
}

/** Days since 1970-01-01 (UTC arithmetic on a calendar date is exact). */
export function toDayNumber(s: string): number {
  const [y, m, d] = parts(s);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

export function fromDayNumber(n: number): string {
  const dt = new Date(n * 86_400_000);
  return fromParts(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function addDays(s: string, n: number): string {
  return fromDayNumber(toDayNumber(s) + n);
}

/** Add months, clamping the day to the target month's length (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(s: string, n: number): string {
  const [y, m, d] = parts(s);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return fromParts(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

export function addYears(s: string, n: number): string {
  return addMonths(s, n * 12);
}

export function startOfMonth(s: string): string {
  const [y, m] = parts(s);
  return fromParts(y, m, 1);
}

export function endOfMonth(s: string): string {
  const [y, m] = parts(s);
  return fromParts(y, m, daysInMonth(y, m));
}

export function daysBetween(a: string, b: string): number {
  return toDayNumber(b) - toDayNumber(a);
}

export function compareDates(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function maxDate(a: string, b: string): string {
  return a >= b ? a : b;
}

export function minDate(a: string, b: string): string {
  return a <= b ? a : b;
}

/** Today's calendar date in an IANA time zone (the organization's). */
export function todayIn(timeZone = "UTC", now: Date = new Date()): string {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  return f.format(now); // en-CA formats as YYYY-MM-DD
}

/** Whole months between two month starts (inclusive count of months covered). */
export function monthsBetween(a: string, b: string): number {
  const [ya, ma] = parts(a);
  const [yb, mb] = parts(b);
  return (yb - ya) * 12 + (mb - ma);
}
