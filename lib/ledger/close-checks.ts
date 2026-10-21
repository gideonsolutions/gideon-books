/**
 * The period-close checklist. Each check looks at the period being closed
 * and reports pass or fail; a failing "blocker" stops the close, a failing
 * "warning" must be acknowledged. Modules contribute their checks through
 * MODULE_CHECKS below.
 */
import { and, eq, gte, isNull, lte, sql, inArray } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import { accounts, journalEntries, journalLines } from "@/lib/db/schema/ledger";
import { documents } from "@/lib/db/schema/commerce";
import type { Ctx } from "@/lib/context";
import { Decimal } from "@/lib/money/decimal";
import { bankingCloseChecks } from "@/lib/banking/close-check";
import { assetsCloseChecks } from "@/lib/assets/close-check";
import { inventoryCloseChecks } from "@/lib/inventory/close-check";
import { fxCloseChecks } from "@/lib/fx/close-check";
import { payrollCloseChecks } from "@/lib/payroll/close-check";

export interface PeriodRef {
  id: string;
  startDate: string;
  endDate: string;
}

export interface CloseCheckResult {
  key: string;
  title: string;
  status: "pass" | "fail";
  severity: "blocker" | "warning";
  detail?: string;
  /** Path under the organization (e.g. "/banking/reconcile") where it can be fixed. */
  href?: string;
}

export type CloseCheck = (db: DbOrTx, ctx: Ctx, period: PeriodRef) => Promise<CloseCheckResult[]>;

const coreChecks: CloseCheck = async (db, ctx, period) => {
  const results: CloseCheckResult[] = [];

  const [tb] = await db
    .select({ total: sql<string>`coalesce(sum(${journalLines.baseAmount}), 0)::text` })
    .from(journalLines)
    .innerJoin(journalEntries, and(eq(journalEntries.id, journalLines.entryId), eq(journalEntries.orgId, journalLines.orgId)))
    .where(and(eq(journalLines.orgId, ctx.orgId), eq(journalEntries.status, "posted"), lte(journalEntries.entryDate, period.endDate)));
  const tbOk = Decimal.from(tb?.total ?? "0").isZero();
  results.push({
    key: "trial_balance",
    title: "Trial balance is in balance",
    status: tbOk ? "pass" : "fail",
    severity: "blocker",
    ...(tbOk ? {} : { detail: `Debits and credits differ by ${tb?.total}. This should be impossible; contact support with the audit log.` }),
  });

  const [drafts] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.orgId, ctx.orgId),
        eq(journalEntries.status, "draft"),
        gte(journalEntries.entryDate, period.startDate),
        lte(journalEntries.entryDate, period.endDate),
      ),
    );
  results.push({
    key: "draft_journals",
    title: "No draft journal entries dated in the period",
    status: (drafts?.n ?? 0) === 0 ? "pass" : "fail",
    severity: "warning",
    ...((drafts?.n ?? 0) > 0 ? { detail: `${drafts!.n} draft entr${drafts!.n === 1 ? "y" : "ies"} will not be in the closed period.`, href: "/journal?status=draft" } : {}),
  });

  const [draftDocs] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(documents)
    .where(
      and(
        eq(documents.orgId, ctx.orgId),
        eq(documents.status, "draft"),
        inArray(documents.kind, ["invoice", "credit_note", "bill", "vendor_credit", "expense", "sales_receipt"]),
        gte(documents.issueDate, period.startDate),
        lte(documents.issueDate, period.endDate),
      ),
    );
  results.push({
    key: "draft_documents",
    title: "No draft invoices, bills or expenses dated in the period",
    status: (draftDocs?.n ?? 0) === 0 ? "pass" : "fail",
    severity: "warning",
    ...((draftDocs?.n ?? 0) > 0 ? { detail: `${draftDocs!.n} draft document${draftDocs!.n === 1 ? "" : "s"} dated in the period are not posted.` } : {}),
  });

  const [orphans] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(journalLines)
    .innerJoin(accounts, and(eq(accounts.id, journalLines.accountId), eq(accounts.orgId, journalLines.orgId)))
    .where(
      and(
        eq(journalLines.orgId, ctx.orgId),
        inArray(accounts.control, ["receivables", "payables", "customer_deposits", "vendor_prepayments"]),
        isNull(journalLines.openItemId),
      ),
    );
  results.push({
    key: "subledger_integrity",
    title: "Receivables and payables subledgers agree with the ledger",
    status: (orphans?.n ?? 0) === 0 ? "pass" : "fail",
    severity: "blocker",
    ...((orphans?.n ?? 0) > 0 ? { detail: `${orphans!.n} control-account lines have no document or payment.` } : {}),
  });

  const [pendingReversals] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.orgId, ctx.orgId),
        eq(journalEntries.status, "posted"),
        lte(journalEntries.autoReverseOn, period.endDate),
        sql`not exists (select 1 from journal_entries r where r.org_id = ${journalEntries.orgId} and r.reverses_entry_id = ${journalEntries.id})`,
      ),
    );
  results.push({
    key: "auto_reversals",
    title: "Accruals due to reverse in the period have reversed",
    status: (pendingReversals?.n ?? 0) === 0 ? "pass" : "fail",
    severity: "warning",
    ...((pendingReversals?.n ?? 0) > 0
      ? { detail: `${pendingReversals!.n} entr${pendingReversals!.n === 1 ? "y is" : "ies are"} waiting for the reversal job.`, href: "/jobs" }
      : {}),
  });

  return results;
};

const MODULE_CHECKS: CloseCheck[] = [bankingCloseChecks, inventoryCloseChecks, assetsCloseChecks, fxCloseChecks, payrollCloseChecks];

export async function runCloseChecks(db: DbOrTx, ctx: Ctx, period: PeriodRef): Promise<CloseCheckResult[]> {
  const out = await coreChecks(db, ctx, period);
  for (const check of MODULE_CHECKS) out.push(...(await check(db, ctx, period)));
  return out;
}
