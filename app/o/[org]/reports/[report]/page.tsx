import { notFound } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { requirePermission } from "@/lib/context";
import { buildReport, reportDef } from "@/lib/reports/registry";
import { resolveParams } from "@/lib/reports/scope";
import { reportPageOptions } from "@/lib/reports/page-data";
import { readParams, type SearchParams } from "@/lib/web/params";
import { EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { ReportControls } from "@/components/reports/report-controls";
import { ReportTableView } from "@/components/reports/report-table";

export async function generateMetadata({ params }: { params: Promise<{ report: string }> }) {
  const { report } = await params;
  return { title: reportDef(report)?.title ?? "Report" };
}

export default async function ReportPage({ params, searchParams }: { params: Promise<{ org: string; report: string }>; searchParams: SearchParams }) {
  const { org, report } = await params;
  const def = reportDef(report);
  if (!def) notFound();
  const ctx = await orgCtx(org);
  requirePermission(ctx, "reports.read");
  const sp = await readParams(searchParams);
  const db = getDb();
  const { dims, budgets } = await reportPageOptions(db, ctx.orgId);
  const base = `/o/${org}`;
  if (def.key === "budget-vs-actual" && !sp.budget) {
    if (budgets[0]) sp.budget = budgets[0].value;
    else {
      return (
        <>
          <PageHeader title={def.title} description={def.description} />
          <EmptyState title="No budgets yet" action={<LinkButton href={`${base}/budgets/new`}>Create a budget</LinkButton>}>
            Create a budget for a fiscal year, then compare it with actual results here.
          </EmptyState>
        </>
      );
    }
  }
  const resolved = resolveParams(ctx.org, sp, def.defaultPreset ?? "year_to_date");
  const table = await buildReport(db, ctx.org, def.key, sp);
  return (
    <>
      <PageHeader title={table.title} description={<>{table.subtitle}</>} />
      <ReportControls def={def} resolved={resolved} params={sp} base={base} dims={dims} budgets={budgets} exportPath={`/reports/${def.key}/export`} />
      <div className="mb-3 hidden text-sm text-slate-600 print:block">
        {ctx.org.name} · {table.subtitle} · {table.currency}
      </div>
      <ReportTableView table={table} base={base} />
    </>
  );
}
