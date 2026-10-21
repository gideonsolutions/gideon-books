/**
 * CSV and PDF renderings of a ReportTable. Both are drawn from the same
 * object the page shows, so an export can never disagree with the screen.
 */
import { formatDate, formatMoney, formatNumber } from "@/lib/money/format";
import { Decimal } from "@/lib/money/decimal";
import { PdfWriter, pdfMoney, type PdfColumn, type PdfRow } from "@/lib/pdf/core";
import type { ReportCell, ReportColumn, ReportTable } from "./table";

function csvEscape(v: string): string {
  // Neutralize spreadsheet formulas in text cells (CSV injection).
  const safe = /^[=+\-@\t\r]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** CSV: title and subtitle, a blank line, the header, the rows, then notes. Amounts are plain decimals. */
export function toCsv(t: ReportTable): string {
  const lines: string[] = [];
  lines.push(csvEscape(t.title));
  lines.push(csvEscape(`${t.subtitle} · ${t.currency}`));
  lines.push("");
  lines.push(t.columns.map((c) => csvEscape(c.label)).join(","));
  for (const r of t.rows) {
    lines.push(
      r.cells
        .map((c, i) => {
          const v = c.value ?? "";
          if (i === 0 && r.level) return csvEscape(`${"  ".repeat(r.level)}${v}`);
          return csvEscape(v);
        })
        .join(","),
    );
  }
  if (t.warnings?.length || t.notes?.length) lines.push("");
  for (const w of t.warnings ?? []) lines.push(csvEscape(`Warning: ${w}`));
  for (const n of t.notes ?? []) lines.push(csvEscape(n));
  return lines.join("\r\n") + "\r\n";
}

export function displayCell(c: ReportCell, col: ReportColumn, currency: string): string {
  if (c.value === null || c.value === "") return "";
  switch (col.kind) {
    case "money":
      return Decimal.isValid(c.value) ? formatMoney(c.value, currency, { symbol: false }) : c.value;
    case "number":
      return Decimal.isValid(c.value) ? formatNumber(c.value) : c.value;
    case "percent":
      return Decimal.isValid(c.value) ? `${formatNumber(c.value, 1)}%` : c.value;
    case "date":
      return /^\d{4}-\d{2}-\d{2}$/.test(c.value) ? formatDate(c.value) : c.value;
    default:
      return c.value;
  }
}

/** PDF: the same rows, money formatted, with notes and warnings at the end. */
export async function toPdf(t: ReportTable, orgName: string): Promise<Uint8Array> {
  const w = await PdfWriter.create({ title: t.title, subtitle: `${t.subtitle} · ${t.currency}`, org: orgName }, `${orgName} · ${t.title}`);
  const n = t.columns.length;
  const first = n <= 2 ? 0.6 : n <= 4 ? 0.4 : n <= 6 ? 0.3 : 0.22;
  const rest = (1 - first) / Math.max(1, n - 1);
  const cols: PdfColumn[] = t.columns.map((c, i) => ({ header: c.label, width: i === 0 ? first : rest, align: c.align ?? (c.kind === "money" || c.kind === "number" || c.kind === "percent" ? "right" : "left") }));
  const rows: PdfRow[] = t.rows.map((r) => ({
    cells: r.cells.map((c, i) => {
      const col = t.columns[i]!;
      const shown = displayCell(c, col, t.currency);
      return col.kind === "money" ? pdfMoney(shown, t.currency) : shown;
    }),
    bold: r.kind === "total" || r.kind === "subtotal" || r.kind === "section",
    ruleAbove: r.kind === "total",
    indent: r.level ?? 0,
    muted: r.kind === "note",
  }));
  w.table(cols, rows, { size: n > 7 ? 7 : 8.5 });
  if (t.warnings?.length) {
    w.space(10);
    for (const x of t.warnings) w.paragraph(`Warning: ${x}`, { size: 9 });
  }
  if (t.notes?.length) {
    w.space(10);
    for (const x of t.notes) w.paragraph(x, { size: 8 });
  }
  return w.finish();
}

/** The figures of a table's total row(s), for checks. */
export function totalRows(t: ReportTable) {
  return t.rows.filter((r) => r.kind === "total");
}
