"use server";

import { createBudget, deleteBudget, saveBudgetCells, updateBudget } from "@/lib/budgets/budgets";
import type { BudgetDimension } from "@/lib/db/schema/planning";
import { runAction, str, type ActionResult } from "@/lib/web/actions";
import { orgCtx } from "@/lib/web/session";

type R<T = unknown> = Promise<ActionResult<T>>;

export async function createBudgetAction(slug: string, _: unknown, fd: FormData): R<{ href: string }> {
  return runAction(async () => {
    const ctx = await orgCtx(slug);
    const start = str(fd, "start") ?? "none";
    const b = await createBudget(ctx, {
      name: str(fd, "name") ?? "",
      fiscalYearStart: str(fd, "fiscalYearStart") ?? "",
      dimension: (str(fd, "dimension") as BudgetDimension | null) ?? null,
      notes: str(fd, "notes"),
      copyActuals: start === "actuals" ? { basis: str(fd, "basis") === "cash" ? "cash" : "accrual", adjustPercent: str(fd, "adjustPercent") } : null,
      copyBudgetId: start === "budget" ? str(fd, "copyBudgetId") : null,
    });
    return { href: `/o/${slug}/budgets/${b.id}` };
  });
}

export async function saveCellsAction(slug: string, budgetId: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    const ctx = await orgCtx(slug);
    const cells: { accountId: string; dimensionKey: string; periodStart: string; amount: string | null }[] = [];
    for (const [k, v] of fd.entries()) {
      const m = /^cell\|([0-9a-f-]{36})\|([0-9a-f-]{36}|)\|(\d{4}-\d{2}-\d{2})$/.exec(k);
      if (!m || typeof v !== "string") continue;
      cells.push({ accountId: m[1]!, dimensionKey: m[2]!, periodStart: m[3]!, amount: v });
    }
    await saveBudgetCells(ctx, budgetId, cells);
  }, "Budget saved.");
}

export async function updateBudgetAction(slug: string, budgetId: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await updateBudget(await orgCtx(slug), budgetId, { name: str(fd, "name") ?? "", status: (str(fd, "status") ?? "active") as "active", notes: str(fd, "notes") });
  }, "Saved.");
}

export async function deleteBudgetAction(slug: string, budgetId: string): R<{ href: string }> {
  return runAction(async () => {
    await deleteBudget(await orgCtx(slug), budgetId);
    return { href: `/o/${slug}/budgets` };
  });
}
