import Link from "next/link";
import { cx } from "@/components/ui";

/** Sub-navigation for the payroll pages. */
export function PayrollTabs({ org, current }: { org: string; current: "runs" | "import" | "mappings" | "reports" }) {
  const tabs = [
    { key: "runs", label: "Payroll runs", href: `/o/${org}/payroll` },
    { key: "import", label: "Import", href: `/o/${org}/payroll/import` },
    { key: "mappings", label: "Mappings", href: `/o/${org}/payroll/mappings` },
    { key: "reports", label: "Summary & liabilities", href: `/o/${org}/payroll/reports` },
  ];
  return (
    <nav className="mb-6 flex flex-wrap gap-1 border-b border-slate-200 no-print" aria-label="Payroll">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={current === t.key ? "page" : undefined}
          className={cx("-mb-px border-b-2 px-3 py-2 text-sm font-medium", current === t.key ? "border-brand-600 text-brand-700" : "border-transparent text-slate-600 hover:text-slate-900")}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
