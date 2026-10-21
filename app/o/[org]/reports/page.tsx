import Link from "next/link";
import { orgCtx } from "@/lib/web/session";
import { requirePermission } from "@/lib/context";
import { OTHER_REPORTS, REPORTS } from "@/lib/reports/registry";
import { PageHeader } from "@/components/ui";

export const metadata = { title: "Reports" };

const ORDER = ["Financial statements", "Ledger", "Receivables and payables", "Tax", "Operations", "Planning", "Organization types", "Multi-entity"];

export default async function ReportsIndex({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await orgCtx(org);
  requirePermission(ctx, "reports.read");
  const base = `/o/${org}`;
  const all = [
    ...REPORTS.map((r) => ({ title: r.title, description: r.description, href: `/reports/${r.key}`, category: r.category as string })),
    ...OTHER_REPORTS,
  ];
  return (
    <>
      <PageHeader
        title="Reports"
        description={`Every report runs on posted entries, on the accrual or cash basis (your default is ${ctx.org.reportingBasis}), in ${ctx.org.baseCurrency}. Every figure links to the ledger lines behind it, and every report exports to CSV and PDF.`}
      />
      <div className="space-y-8">
        {ORDER.map((cat) => {
          const items = all.filter((r) => r.category === cat);
          if (!items.length) return null;
          return (
            <section key={cat}>
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">{cat}</h2>
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {items.map((r) => (
                  <li key={r.href}>
                    <Link href={`${base}${r.href}`} className="block h-full rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition hover:border-brand-200 hover:shadow">
                      <div className="font-semibold text-slate-900">{r.title}</div>
                      <p className="mt-1 text-sm text-slate-600">{r.description}</p>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </>
  );
}
