/** Data a report page needs besides the report: dimension and budget choices. */
import type { DbOrTx } from "@/lib/db/client";
import { dimensionOptions } from "@/lib/web/options";
import { listBudgets } from "@/lib/budgets/budgets";

export async function reportPageOptions(db: DbOrTx, orgId: string) {
  const dims = await dimensionOptions(db, orgId);
  const budgets = (await listBudgets(db, orgId)).map((b) => ({ value: b.budget.id, label: `${b.budget.name} (${b.budget.fiscalYearStart.slice(0, 7)})` }));
  return { dims, budgets };
}
