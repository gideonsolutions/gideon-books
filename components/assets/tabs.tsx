import Link from "next/link";
import { cx } from "@/components/ui";

/** Sub-navigation for the fixed-assets pages. */
export function AssetTabs({ org, current }: { org: string; current: "register" | "depreciation" | "rollforward" }) {
  const tabs = [
    { key: "register", label: "Asset register", href: `/o/${org}/assets` },
    { key: "depreciation", label: "Depreciation runs", href: `/o/${org}/assets/depreciation` },
    { key: "rollforward", label: "Rollforward", href: `/o/${org}/assets/rollforward` },
  ];
  return (
    <nav className="mb-6 flex gap-1 border-b border-slate-200 no-print" aria-label="Fixed assets">
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
