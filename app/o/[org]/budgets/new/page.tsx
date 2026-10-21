import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { requirePermission } from "@/lib/context";
import { listBudgets } from "@/lib/budgets/budgets";
import { fiscalYearStart } from "@/lib/ledger/periods";
import { addMonths, todayIn } from "@/lib/dates";
import { Card, PageHeader } from "@/components/ui";
import { NewBudgetForm } from "@/components/budgets/new-budget-form";
import { createBudgetAction } from "../actions";

export const metadata = { title: "New budget" };

export default async function NewBudget({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await orgCtx(org);
  requirePermission(ctx, "budgets.manage");
  const thisFy = fiscalYearStart(todayIn(ctx.org.timezone), ctx.org.fiscalYearStartMonth);
  const years = [-1, 0, 1].map((n) => addMonths(thisFy, n * 12));
  const existing = (await listBudgets(getDb(), ctx.orgId)).map((b) => ({ value: b.budget.id, label: b.budget.name }));
  return (
    <>
      <PageHeader title="New budget" back={{ href: `/o/${org}/budgets`, label: "Budgets" }} />
      <Card className="max-w-2xl">
        <NewBudgetForm action={createBudgetAction.bind(null, org)} years={years} defaultYear={thisFy} existing={existing} basis={ctx.org.reportingBasis} />
      </Card>
    </>
  );
}
