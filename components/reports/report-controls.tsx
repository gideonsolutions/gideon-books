import Link from "next/link";
import { buttonClass, FilterField, inputClass } from "@/components/ui";
import { PRESET_LABELS, type Preset, type ResolvedParams } from "@/lib/reports/scope";
import type { ReportDef } from "@/lib/reports/registry";
import type { Option } from "@/components/client/forms";
import { qs } from "@/lib/reports/table";

const COMPARE_LABELS: Record<string, string> = {
  none: "No comparison",
  previous_period: "Previous period",
  previous_year: "Previous year",
  months: "Month by month",
  quarters: "Quarter by quarter",
};

const DIMENSION_LABELS: Record<string, string> = { project: "Project", class: "Class", department: "Department", location: "Location", fund: "Fund" };

export interface DimensionOptionLists {
  projects: Option[];
  classes: Option[];
  departments: Option[];
  locations: Option[];
  funds: Option[];
}

function Select({ name, value, options, empty }: { name: string; value: string | undefined; options: { value: string; label: string }[]; empty?: string }) {
  return (
    <select name={name} defaultValue={value ?? ""} className={inputClass}>
      {empty !== undefined && <option value="">{empty}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/**
 * The report's controls as a GET form (the URL is the state, so any view can
 * be bookmarked or shared), and export links carrying the same parameters.
 */
export function ReportControls({
  def,
  resolved,
  params,
  base,
  dims,
  budgets,
  exportPath,
}: {
  def: Pick<ReportDef, "key" | "dates" | "basis" | "compare" | "dimensionColumns" | "filters" | "extra">;
  resolved: ResolvedParams;
  params: Record<string, string | undefined>;
  base: string;
  dims?: DimensionOptionLists;
  budgets?: Option[];
  exportPath: string;
}) {
  const presets = (Object.keys(PRESET_LABELS) as Preset[]).filter((p) => (def.dates === "asOf" ? ["this_month", "last_month", "this_quarter", "last_quarter", "this_fiscal_year", "last_fiscal_year", "custom"].includes(p) : true));
  const exportQuery = qs({ ...params, page: undefined, period: resolved.preset === "custom" ? undefined : resolved.preset, from: resolved.from, to: resolved.to, basis: resolved.basis });
  const dimLists: [string, string, Option[]][] = dims
    ? [
        ["project", "Project", dims.projects],
        ["class", "Class", dims.classes],
        ["department", "Department", dims.departments],
        ["location", "Location", dims.locations],
        ["fund", "Fund", dims.funds],
      ]
    : [];
  return (
    <div className="mb-4 space-y-3 no-print">
      <form method="get" className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
        <FilterField label={def.dates === "asOf" ? "As of" : "Period"}>
          <Select name="period" value={resolved.preset} options={presets.map((p) => ({ value: p, label: def.dates === "asOf" && p !== "custom" ? `End of ${PRESET_LABELS[p].toLowerCase()}` : PRESET_LABELS[p] }))} />
        </FilterField>
        {def.dates === "range" && (
          <FilterField label="From">
            <input type="date" name="from" defaultValue={resolved.from} className={inputClass} />
          </FilterField>
        )}
        <FilterField label={def.dates === "range" ? "To" : "Date"}>
          <input type="date" name="to" defaultValue={resolved.to} className={inputClass} />
        </FilterField>
        {def.basis && (
          <FilterField label="Basis">
            <Select
              name="basis"
              value={resolved.basis}
              options={[
                { value: "accrual", label: "Accrual" },
                { value: "cash", label: "Cash" },
              ]}
            />
          </FilterField>
        )}
        {def.compare && (
          <FilterField label="Compare">
            <Select name="compare" value={params.compare ?? "none"} options={def.compare.map((c) => ({ value: c, label: COMPARE_LABELS[c]! }))} />
          </FilterField>
        )}
        {def.dimensionColumns && (
          <FilterField label="Columns by">
            <Select name="columns" value={params.columns} empty="Period" options={Object.entries(DIMENSION_LABELS).map(([value, label]) => ({ value, label }))} />
          </FilterField>
        )}
        {def.filters &&
          dimLists
            .filter(([, , opts]) => opts.length > 0)
            .map(([key, label, opts]) => (
              <FilterField key={key} label={label}>
                <Select name={key} value={params[key]} empty="All" options={[{ value: "none", label: "Not assigned" }, ...opts]} />
              </FilterField>
            ))}
        {def.filters && (
          <FilterField label="Trust">
            <Select
              name="trust"
              value={params.trust}
              empty="All"
              options={[
                { value: "principal", label: "Principal" },
                { value: "income", label: "Income" },
              ]}
            />
          </FilterField>
        )}
        {def.extra?.includes("detail") && (
          <label className="flex items-center gap-2 pb-2 text-sm text-slate-700">
            <input type="checkbox" name="detail" value="1" defaultChecked={params.detail === "1"} /> Show documents
          </label>
        )}
        {def.extra?.includes("budget") && budgets && (
          <FilterField label="Budget">
            <Select name="budget" value={params.budget} options={budgets} />
          </FilterField>
        )}
        {params.account && <input type="hidden" name="account" value={params.account} />}
        {params.contact && <input type="hidden" name="contact" value={params.contact} />}
        {params.beneficiary && <input type="hidden" name="beneficiary" value={params.beneficiary} />}
        <button type="submit" className={buttonClass("primary")}>
          Run report
        </button>
      </form>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <a href={`${base}${exportPath}?${exportQuery}&format=csv`} className={buttonClass("secondary", "sm")} download>
          Export CSV
        </a>
        <a href={`${base}${exportPath}?${exportQuery}&format=pdf`} className={buttonClass("secondary", "sm")}>
          Export PDF
        </a>
        <Link href={`${base}/reports`} className="ml-auto text-slate-500 hover:text-brand-700">
          All reports
        </Link>
      </div>
    </div>
  );
}
