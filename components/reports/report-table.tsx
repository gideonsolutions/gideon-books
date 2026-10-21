import Link from "next/link";
import { Alert, cx } from "@/components/ui";
import { displayCell } from "@/lib/reports/export";
import type { ReportTable } from "@/lib/reports/table";

/** Render a report table. Links in the table are relative to the organization (`base`). */
export function ReportTableView({ table, base }: { table: ReportTable; base: string }) {
  return (
    <div className="space-y-3">
      {table.warnings?.map((w) => (
        <Alert key={w} tone="danger" title="Check this">
          {w}
        </Alert>
      ))}
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm print:border-0 print:shadow-none">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50">
            <tr>
              {table.columns.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className={cx(
                    "whitespace-nowrap px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-slate-600",
                    c.align === "right" || c.kind === "money" || c.kind === "number" || c.kind === "percent" ? "text-right" : "text-left",
                  )}
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.length === 0 && (
              <tr>
                <td colSpan={table.columns.length} className="px-3 py-10 text-center text-sm text-slate-500">
                  Nothing to report for these dates and filters.
                </td>
              </tr>
            )}
            {table.rows.map((r, ri) => (
              <tr
                key={ri}
                className={cx(
                  "border-t border-slate-100",
                  r.kind === "section" && "bg-slate-50/60",
                  r.kind === "subtotal" && "font-medium",
                  r.kind === "total" && "border-t-2 border-slate-300 bg-slate-50 font-semibold",
                  r.kind === "note" && "text-slate-500",
                )}
              >
                {r.cells.map((c, ci) => {
                  const col = table.columns[ci]!;
                  const numeric = col.kind === "money" || col.kind === "number" || col.kind === "percent";
                  const shown = displayCell(c, col, table.currency);
                  const negative = numeric && c.value?.startsWith("-") && !/^-0(\.0+)?$/.test(c.value);
                  const content = c.href ? (
                    <Link href={`${base}${c.href}`} className={cx("hover:underline", numeric ? "text-inherit" : "text-brand-700")}>
                      {shown}
                    </Link>
                  ) : (
                    shown
                  );
                  return (
                    <td
                      key={ci}
                      className={cx(
                        "px-3 py-1.5 align-top",
                        numeric ? "num text-right" : "",
                        negative && "text-danger-700",
                        ci === 0 && r.kind === "section" && "pt-3 text-xs font-semibold uppercase tracking-wide text-slate-600",
                      )}
                      style={ci === 0 && r.level ? { paddingLeft: `${0.75 + r.level * 1.1}rem` } : undefined}
                    >
                      {content}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {table.notes?.map((n) => (
        <p key={n} className="text-xs text-slate-500">
          {n}
        </p>
      ))}
    </div>
  );
}
