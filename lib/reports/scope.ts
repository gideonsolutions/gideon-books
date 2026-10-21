/**
 * What a report covers: the organization, the dates, the accounting basis
 * and any filters. Every report reads the same scope from the URL, so a
 * number on one report links to the general ledger with exactly the filters
 * that produced it.
 */
import type { Org } from "@/lib/context";
import { addDays, addMonths, endOfMonth, isIsoDate, parts, startOfMonth, todayIn } from "@/lib/dates";
import { fiscalYearStart } from "@/lib/ledger/periods";

export type Basis = "accrual" | "cash";

/** Dimension filters take an id, or "none" for lines without one. */
export interface LineFilters {
  accountIds?: string[];
  contactId?: string;
  projectId?: string;
  classId?: string;
  departmentId?: string;
  locationId?: string;
  fundId?: string;
  trustComponent?: "principal" | "income";
  beneficiaryId?: string;
}

export interface ReportScope extends LineFilters {
  orgId: string;
  basis: Basis;
  from: string;
  to: string;
}

/** Filter keys as they appear in URLs. */
export const FILTER_PARAMS: Record<keyof LineFilters, string> = {
  accountIds: "account",
  contactId: "contact",
  projectId: "project",
  classId: "class",
  departmentId: "department",
  locationId: "location",
  fundId: "fund",
  trustComponent: "trust",
  beneficiaryId: "beneficiary",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readFilters(p: Record<string, string | undefined>): LineFilters {
  const f: LineFilters = {};
  const ids = (p.account ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => UUID_RE.test(s));
  if (ids.length) f.accountIds = ids;
  const one = (k: string) => (p[k] && (UUID_RE.test(p[k]!) || (k !== "contact" && k !== "beneficiary" && p[k] === "none")) ? p[k] : undefined);
  const contact = one("contact");
  if (contact) f.contactId = contact;
  const project = one("project");
  if (project) f.projectId = project;
  const cls = one("class");
  if (cls) f.classId = cls;
  const dept = one("department");
  if (dept) f.departmentId = dept;
  const loc = one("location");
  if (loc) f.locationId = loc;
  const fund = one("fund");
  if (fund) f.fundId = fund;
  if (p.trust === "principal" || p.trust === "income") f.trustComponent = p.trust;
  const ben = one("beneficiary");
  if (ben) f.beneficiaryId = ben;
  return f;
}

export function filterParams(f: LineFilters): Record<string, string> {
  const out: Record<string, string> = {};
  if (f.accountIds?.length) out.account = f.accountIds.join(",");
  if (f.contactId) out.contact = f.contactId;
  if (f.projectId) out.project = f.projectId;
  if (f.classId) out.class = f.classId;
  if (f.departmentId) out.department = f.departmentId;
  if (f.locationId) out.location = f.locationId;
  if (f.fundId) out.fund = f.fundId;
  if (f.trustComponent) out.trust = f.trustComponent;
  if (f.beneficiaryId) out.beneficiary = f.beneficiaryId;
  return out;
}

export function hasFilters(f: LineFilters): boolean {
  return Object.keys(filterParams(f)).length > 0;
}

export type Preset =
  | "this_month"
  | "last_month"
  | "this_quarter"
  | "last_quarter"
  | "year_to_date"
  | "this_fiscal_year"
  | "last_fiscal_year"
  | "last_12_months"
  | "custom";

export const PRESET_LABELS: Record<Preset, string> = {
  this_month: "This month",
  last_month: "Last month",
  this_quarter: "This quarter",
  last_quarter: "Last quarter",
  year_to_date: "Fiscal year to date",
  this_fiscal_year: "This fiscal year",
  last_fiscal_year: "Last fiscal year",
  last_12_months: "Last 12 months",
  custom: "Custom",
};

/** The fiscal quarter start containing `date`. */
function quarterStart(date: string, fyStartMonth: number): string {
  const fy = fiscalYearStart(date, fyStartMonth);
  const [y, m] = parts(date);
  const [fy0, fm] = parts(fy);
  const monthsIn = (y - fy0) * 12 + (m - fm);
  return addMonths(fy, Math.floor(monthsIn / 3) * 3);
}

export function presetRange(preset: Preset, today: string, fyStartMonth: number): { from: string; to: string } {
  switch (preset) {
    case "this_month":
      return { from: startOfMonth(today), to: endOfMonth(today) };
    case "last_month": {
      const s = addMonths(startOfMonth(today), -1);
      return { from: s, to: endOfMonth(s) };
    }
    case "this_quarter": {
      const s = quarterStart(today, fyStartMonth);
      return { from: s, to: addDays(addMonths(s, 3), -1) };
    }
    case "last_quarter": {
      const s = addMonths(quarterStart(today, fyStartMonth), -3);
      return { from: s, to: addDays(addMonths(s, 3), -1) };
    }
    case "year_to_date":
      return { from: fiscalYearStart(today, fyStartMonth), to: today };
    case "this_fiscal_year": {
      const s = fiscalYearStart(today, fyStartMonth);
      return { from: s, to: addDays(addMonths(s, 12), -1) };
    }
    case "last_fiscal_year": {
      const s = addMonths(fiscalYearStart(today, fyStartMonth), -12);
      return { from: s, to: addDays(addMonths(s, 12), -1) };
    }
    case "last_12_months": {
      const s = addMonths(startOfMonth(today), -11);
      return { from: s, to: endOfMonth(today) };
    }
    default:
      return { from: fiscalYearStart(today, fyStartMonth), to: today };
  }
}

export interface ResolvedParams {
  preset: Preset;
  from: string;
  to: string;
  basis: Basis;
  filters: LineFilters;
  today: string;
}

/** Read dates, basis and filters from search params, with the organization's defaults. */
export function resolveParams(org: Org, p: Record<string, string | undefined>, defaultPreset: Preset = "year_to_date"): ResolvedParams {
  const today = todayIn(org.timezone);
  let preset: Preset = p.period && p.period in PRESET_LABELS ? (p.period as Preset) : p.from || p.to ? "custom" : defaultPreset;
  let { from, to } = presetRange(preset === "custom" ? defaultPreset : preset, today, org.fiscalYearStartMonth);
  // Dates typed into the form override a preset they no longer match.
  const typedFrom = p.from && isIsoDate(p.from) ? p.from : null;
  const typedTo = p.to && isIsoDate(p.to) ? p.to : p.asOf && isIsoDate(p.asOf) ? p.asOf : null;
  if (preset === "custom" || (typedFrom && typedFrom !== from) || (typedTo && typedTo !== to)) {
    if (preset !== "custom" && ((typedFrom && typedFrom !== from) || (typedTo && typedTo !== to))) preset = "custom";
    if (typedFrom) from = typedFrom;
    if (typedTo) to = typedTo;
  }
  if (from > to) [from, to] = [to, from];
  const basis: Basis = p.basis === "cash" || p.basis === "accrual" ? p.basis : org.reportingBasis;
  return { preset, from, to, basis, filters: readFilters(p), today };
}

export function scopeFrom(org: Org, r: ResolvedParams): ReportScope {
  return { orgId: org.id, basis: r.basis, from: r.from, to: r.to, ...r.filters };
}

/** The day before a date. */
export function dayBefore(date: string): string {
  return addDays(date, -1);
}

/** First day of the fiscal year containing `date`. */
export function fyStartOf(org: Pick<Org, "fiscalYearStartMonth">, date: string): string {
  return fiscalYearStart(date, org.fiscalYearStartMonth);
}

