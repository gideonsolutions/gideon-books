import Link from "next/link";
import { buttonClass, cx, FilterField, inputClass } from "@/components/ui";
import { RETURN_TYPE_LABELS } from "@/lib/taxexport/catalogs";
import { TAX_RETURN_TYPES } from "@/lib/db/schema/taxexport";
import { selectionQuery, type TaxSelection } from "@/lib/taxexport/params";

/** Return type / tax year / basis selection, and the section tabs, for the tax pages. */
export function TaxHeader({ base, sel, current }: { base: string; sel: TaxSelection; current: "overview" | "mappings" | "adjustments" }) {
  const q = selectionQuery(sel);
  const tabs = [
    { key: "overview", label: "Reconciliation and export", href: `${base}/tax?${q}` },
    { key: "mappings", label: "Account mappings", href: `${base}/tax/mappings?${q}` },
    { key: "adjustments", label: "Book-to-tax adjustments", href: `${base}/tax/adjustments?${q}` },
  ];
  return (
    <div className="mb-6 space-y-3 no-print">
      <form method="get" className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
        <FilterField label="Return">
          <select name="rt" defaultValue={sel.returnType} className={inputClass}>
            {TAX_RETURN_TYPES.map((rt) => (
              <option key={rt} value={rt}>
                {RETURN_TYPE_LABELS[rt]}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Tax year">
          <select name="year" defaultValue={sel.taxYearStart} className={inputClass}>
            {sel.years.map((y) => (
              <option key={y.start} value={y.start}>
                {y.label} ({y.start} – {y.end})
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Basis">
          <select name="basis" defaultValue={sel.basis} className={inputClass}>
            <option value="accrual">Accrual</option>
            <option value="cash">Cash</option>
          </select>
        </FilterField>
        <button type="submit" className={buttonClass("secondary")}>
          Show
        </button>
      </form>
      <nav className="flex flex-wrap gap-1 border-b border-slate-200" aria-label="Tax sections">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={t.href}
            aria-current={t.key === current ? "page" : undefined}
            className={cx("-mb-px border-b-2 px-3 py-2 text-sm font-medium", t.key === current ? "border-brand-600 text-brand-700" : "border-transparent text-slate-600 hover:text-slate-900")}
          >
            {t.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}

export function SelectionFields({ sel }: { sel: TaxSelection }) {
  return (
    <>
      <input type="hidden" name="rt" value={sel.returnType} />
      <input type="hidden" name="yearStart" value={sel.taxYearStart} />
      <input type="hidden" name="yearEnd" value={sel.taxYearEnd} />
      <input type="hidden" name="basis" value={sel.basis} />
    </>
  );
}
