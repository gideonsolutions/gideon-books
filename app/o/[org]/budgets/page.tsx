import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { can, requirePermission } from "@/lib/context";
import { listBudgets } from "@/lib/budgets/budgets";
import { Badge, DateText, EmptyState, LinkButton, Money, PageHeader, Table, Td, Th } from "@/components/ui";

export const metadata = { title: "Budgets" };

export default async function Budgets({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await orgCtx(org);
  requirePermission(ctx, "reports.read");
  const rows = await listBudgets(getDb(), ctx.orgId);
  const base = `/o/${org}`;
  return (
    <>
      <PageHeader
        title="Budgets"
        description="Monthly amounts for income and expense accounts over a fiscal year, optionally by project, class, department, location or fund. Compare them with what happened in Budget vs actual."
        actions={can(ctx, "budgets.manage") && <LinkButton href={`${base}/budgets/new`}>New budget</LinkButton>}
      />
      {rows.length === 0 ? (
        <EmptyState title="No budgets yet" action={can(ctx, "budgets.manage") && <LinkButton href={`${base}/budgets/new`}>Create a budget</LinkButton>}>
          Start from last year&apos;s actual results, adjusted by a percentage, or from scratch.
        </EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Fiscal year from</Th>
              <Th>By</Th>
              <Th>Status</Th>
              <Th align="right">Total budgeted</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map(({ budget, total, lines }) => (
              <tr key={budget.id}>
                <Td>
                  <Link href={`${base}/budgets/${budget.id}`} className="font-medium text-brand-700 hover:underline">
                    {budget.name}
                  </Link>
                  <div className="text-xs text-slate-500">{lines} amounts</div>
                </Td>
                <Td>
                  <DateText date={budget.fiscalYearStart} />
                </Td>
                <Td>{budget.dimension ?? "Account only"}</Td>
                <Td>
                  <Badge tone={budget.status === "active" ? "green" : budget.status === "draft" ? "amber" : "gray"}>{budget.status}</Badge>
                </Td>
                <Td align="right">
                  <Money amount={total} currency={ctx.org.baseCurrency} />
                </Td>
                <Td align="right">
                  <Link href={`${base}/reports/budget-vs-actual?budget=${budget.id}&period=custom&from=${budget.fiscalYearStart}`} className="text-sm text-brand-700 hover:underline">
                    Budget vs actual
                  </Link>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
