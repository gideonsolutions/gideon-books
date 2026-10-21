/** The tax page's selection (return type, tax year, basis) from the URL. */
import type { Org } from "@/lib/context";
import { TAX_RETURN_TYPES, type TaxReturnType } from "@/lib/db/schema/taxexport";
import { addDays, addMonths, isIsoDate, todayIn } from "@/lib/dates";
import { fiscalYearStart } from "@/lib/ledger/periods";
import { defaultReturnType } from "./catalogs";
import type { Basis } from "@/lib/reports/scope";

export interface TaxSelection {
  returnType: TaxReturnType;
  taxYearStart: string;
  taxYearEnd: string;
  basis: Basis;
  years: { start: string; end: string; label: string }[];
}

export function taxSelection(org: Org, p: Record<string, string | undefined>): TaxSelection {
  const today = todayIn(org.timezone);
  const current = fiscalYearStart(today, org.fiscalYearStartMonth);
  const years = [0, -1, -2, -3].map((n) => {
    const start = addMonths(current, n * 12);
    const end = addDays(addMonths(start, 12), -1);
    return { start, end, label: org.fiscalYearStartMonth === 1 ? start.slice(0, 4) : `${start.slice(0, 4)}–${end.slice(2, 4)}` };
  });
  const returnType = (TAX_RETURN_TYPES as readonly string[]).includes(p.rt ?? "") ? (p.rt as TaxReturnType) : defaultReturnType(org.entityType);
  // Default to the last completed fiscal year: that is the one being prepared.
  const chosen = p.year && isIsoDate(p.year) ? (years.find((y) => y.start === p.year) ?? { start: p.year, end: addDays(addMonths(p.year, 12), -1), label: p.year.slice(0, 4) }) : years[1]!;
  const basis: Basis = p.basis === "cash" || p.basis === "accrual" ? p.basis : org.reportingBasis;
  return { returnType, taxYearStart: chosen.start, taxYearEnd: chosen.end, basis, years };
}

export function selectionQuery(s: Pick<TaxSelection, "returnType" | "taxYearStart" | "basis">): string {
  return new URLSearchParams({ rt: s.returnType, year: s.taxYearStart, basis: s.basis }).toString();
}
