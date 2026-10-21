import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { can, requirePermission } from "@/lib/context";
import { budgetMonths, dimensionChoices, getBudget } from "@/lib/budgets/budgets";
import { loadChart, label } from "@/lib/reports/accounts";
import { readParams, type SearchParams } from "@/lib/web/params";
import { Decimal } from "@/lib/money/decimal";
import { formatDate } from "@/lib/money/format";
import { Card, LinkButton, PageHeader, buttonClass } from "@/components/ui";
import { ActionForm, ConfirmButton, SelectField, SubmitButton, TextAreaField, TextField } from "@/components/client/forms";
import { BudgetGrid } from "@/components/budgets/budget-grid";
import { deleteBudgetAction, saveCellsAction, updateBudgetAction } from "../actions";

export const metadata = { title: "Budget" };

export default async function BudgetPage({ params, searchParams }: { params: Promise<{ org: string; id: string }>; searchParams: SearchParams }) {
  const { org, id } = await params;
  const ctx = await orgCtx(org);
  requirePermission(ctx, "reports.read");
  const sp = await readParams(searchParams);
  const db = getDb();
  const { budget, lines } = await getBudget(db, ctx.orgId, id);
  const chart = await loadChart(db, ctx.orgId);
  const months = budgetMonths(budget.fiscalYearStart);
  const choices = await dimensionChoices(db, ctx.orgId, budget.dimension);
  const dimensionKey = budget.dimension ? (sp.dim !== undefined && (sp.dim === "" || choices.some((c) => c.id === sp.dim)) ? sp.dim : (choices[0]?.id ?? "")) : "";
  const initial: Record<string, string> = {};
  for (const l of lines) if (l.dimensionKey === dimensionKey) initial[`cell|${l.accountId}|${l.dimensionKey}|${l.periodStart}`] = Decimal.from(l.amount).normalize().toString();
  const accounts = chart.ordered
    .filter((a) => (a.type === "income" || a.type === "expense") && (!a.isArchived || lines.some((l) => l.accountId === a.id)))
    .map((a) => ({ id: a.id, label: `${" ".repeat(a.depth)}${label(a)}`, type: a.type as "income" | "expense" }));
  const base = `/o/${org}`;
  const editable = can(ctx, "budgets.manage");
  return (
    <>
      <PageHeader
        title={budget.name}
        description={`Fiscal year from ${formatDate(budget.fiscalYearStart)}${budget.dimension ? `, by ${budget.dimension}` : ""}. ${budget.notes ?? ""}`}
        back={{ href: `${base}/budgets`, label: "Budgets" }}
        actions={
          <>
            <LinkButton variant="secondary" href={`${base}/reports/budget-vs-actual?budget=${id}&period=custom&from=${budget.fiscalYearStart}`}>
              Budget vs actual
            </LinkButton>
            {editable && (
              <ConfirmButton action={deleteBudgetAction.bind(null, org, id)} label="Delete" variant="danger" title="Delete this budget?" body="Its amounts are removed. Actual results are not affected." confirmLabel="Delete budget" />
            )}
          </>
        }
      />
      {budget.dimension && (
        <nav className="mb-4 flex flex-wrap gap-2" aria-label={`Budget ${budget.dimension}`}>
          {[...choices, { id: "", name: "Not assigned" }].map((c) => (
            <Link key={c.id || "none"} href={`?dim=${c.id}`} className={buttonClass(c.id === dimensionKey ? "primary" : "secondary", "sm")} aria-current={c.id === dimensionKey ? "page" : undefined}>
              {c.name}
            </Link>
          ))}
        </nav>
      )}
      <BudgetGrid action={saveCellsAction.bind(null, org, id)} accounts={accounts} months={months} dimensionKey={dimensionKey} initial={initial} currency={ctx.org.baseCurrency} canEdit={editable} />
      {editable && (
        <Card title="Settings" className="mt-6 max-w-xl">
          <ActionForm action={updateBudgetAction.bind(null, org, id)} className="space-y-3">
            <TextField label="Name" name="name" defaultValue={budget.name} required />
            <SelectField
              label="Status"
              name="status"
              defaultValue={budget.status}
              options={[
                { value: "active", label: "Active" },
                { value: "draft", label: "Draft" },
                { value: "archived", label: "Archived" },
              ]}
            />
            <TextAreaField label="Notes" name="notes" defaultValue={budget.notes ?? ""} rows={2} />
            <SubmitButton variant="secondary">Save settings</SubmitButton>
          </ActionForm>
        </Card>
      )}
    </>
  );
}
