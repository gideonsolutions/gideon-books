/**
 * The shape every report renders to: titled columns and rows of cells, with
 * a drill-down link per figure. The page, the CSV and the PDF are all drawn
 * from this one object, so they cannot disagree.
 */
export type CellKind = "text" | "money" | "number" | "percent" | "date";

export interface ReportColumn {
  key: string;
  label: string;
  kind: CellKind;
  align?: "left" | "right";
}

export interface ReportCell {
  /** Text, or a canonical decimal string for money/number/percent, or an ISO date. */
  value: string | null;
  /** Relative link (under /o/<org>) to the rows behind this figure. */
  href?: string;
}

export interface ReportRow {
  cells: ReportCell[];
  /** Indentation level for hierarchical rows. */
  level?: number;
  kind?: "section" | "detail" | "subtotal" | "total" | "note";
}

export interface ReportTable {
  key: string;
  title: string;
  /** "Jan 1, 2026 – Dec 31, 2026 · Accrual basis" */
  subtitle: string;
  currency: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  /** Statements about the report shown under it (and in exports). */
  notes?: string[];
  /** A problem the reader must see (e.g. a cash flow that does not tie out). */
  warnings?: string[];
}

export const text = (value: string | null, href?: string): ReportCell => ({ value, ...(href ? { href } : {}) });
export const money = (value: string | null, href?: string): ReportCell => ({ value, ...(href ? { href } : {}) });

/** Build a query string for a drill-down link. */
export function qs(params: Record<string, string | undefined | null>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, v);
  return q.toString();
}

export function glHref(params: Record<string, string | undefined | null>): string {
  return `/reports/general-ledger?${qs(params)}`;
}
