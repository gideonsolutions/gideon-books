"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db/client";
import type { BankRuleActions, BankRuleConditions, CsvMappingConfig } from "@/lib/db/schema/banking";
import type { PaymentKind } from "@/lib/db/schema/commerce";
import { commitImport, deleteMapping, previewImport, undoImport, type ImportPreview } from "@/lib/banking/imports";
import {
  acceptSuggestions,
  categorizeTransaction,
  confirmReviewed,
  excludeTransactions,
  matchTransactions,
  recordPaymentFromTransaction,
  restoreTransaction,
  transferTransaction,
  undoMatch,
  type SplitInput,
} from "@/lib/banking/transactions";
import { cancelReconciliation, completeReconciliation, setCleared, startReconciliation, undoReconciliation } from "@/lib/banking/reconcile";
import { deleteRule, moveRule, previewRule, runRulesNow, saveRule, type RuleInput } from "@/lib/banking/rules";
import { connectFeed, disconnectFeed, linkFeedAccount, refreshFeedAccounts, syncConnection } from "@/lib/banking/feeds/sync";
import { bool, runAction, str, type ActionResult } from "@/lib/web/actions";
import { orgCtx } from "@/lib/web/session";
import type { AllocationInput } from "@/lib/commerce/payments";

type R<T = unknown> = Promise<ActionResult<T>>;

function refresh(slug: string) {
  revalidatePath(`/o/${slug}/banking`, "layout");
}

// ── Imports ─────────────────────────────────────────────────────────────────

export async function previewImportAction(slug: string, input: { accountId: string; text: string; mapping: CsvMappingConfig }): R<ImportPreview> {
  return runAction(async () => {
    const ctx = await orgCtx(slug);
    const p = await previewImport(getDb(), ctx, input);
    // Keep the payload small: the preview shows at most 500 rows.
    return { ...p, rows: p.rows.slice(0, 500) };
  });
}

export async function commitImportAction(
  slug: string,
  input: { accountId: string; fileName: string; text: string; mapping: CsvMappingConfig; mappingId?: string | null; includeDuplicateRows?: number[]; saveMappingAs?: string | null },
): R<{ href: string }> {
  return runAction(async () => {
    const ctx = await orgCtx(slug);
    const batch = await commitImport(ctx, input);
    refresh(slug);
    return { href: `/o/${slug}/banking/imports/${batch.id}` };
  });
}

export async function undoImportAction(slug: string, batchId: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await undoImport(await orgCtx(slug), batchId, str(fd, "reason") ?? "");
    refresh(slug);
  }, "Import undone. Its transactions are removed from review; the file and rows stay on record.");
}

export async function deleteMappingAction(slug: string, id: string): R {
  return runAction(async () => {
    await deleteMapping(await orgCtx(slug), id);
  }, "Mapping deleted.");
}

// ── Review ──────────────────────────────────────────────────────────────────

export async function matchAction(slug: string, bankTransactionIds: string[], _: unknown, fd: FormData): R<{ href: string }> {
  return runAction(async () => {
    const ctx = await orgCtx(slug);
    const lineIds = fd.getAll("lineId").map(String).filter(Boolean);
    const extraTxns = fd.getAll("bankTransactionId").map(String).filter(Boolean);
    await matchTransactions(ctx, { bankTransactionIds: [...new Set([...bankTransactionIds, ...extraTxns])], journalLineIds: lineIds });
    refresh(slug);
    return { href: `/o/${slug}/banking/transactions/${bankTransactionIds[0]}` };
  });
}

function splitsFrom(fd: FormData): SplitInput[] {
  const out: SplitInput[] = [];
  for (let i = 0; i < 50; i++) {
    if (!fd.has(`splits.${i}.accountId`)) break;
    const accountId = str(fd, `splits.${i}.accountId`);
    const amount = str(fd, `splits.${i}.amount`);
    if (!accountId && !amount) continue;
    out.push({
      accountId: accountId ?? "",
      amount: amount ?? "",
      description: str(fd, `splits.${i}.description`),
      contactId: str(fd, `splits.${i}.contactId`),
      projectId: str(fd, `splits.${i}.projectId`),
      classId: str(fd, `splits.${i}.classId`),
      departmentId: str(fd, `splits.${i}.departmentId`),
      locationId: str(fd, `splits.${i}.locationId`),
      fundId: str(fd, `splits.${i}.fundId`),
    });
  }
  return out;
}

export async function categorizeAction(slug: string, txnId: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    const ctx = await orgCtx(slug);
    await categorizeTransaction(ctx, txnId, {
      splits: splitsFrom(fd),
      memo: str(fd, "memo"),
      contactId: str(fd, "contactId"),
      postingDate: str(fd, "postingDate"),
      ruleId: str(fd, "ruleId"),
    });
    refresh(slug);
  }, "Categorized and posted.");
}

export async function transferAction(slug: string, txnId: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await transferTransaction(await orgCtx(slug), txnId, { toAccountId: str(fd, "toAccountId") ?? "", counterpartId: str(fd, "counterpartId"), memo: str(fd, "memo") });
    refresh(slug);
  }, "Transfer recorded.");
}

export async function paymentFromTxnAction(slug: string, txnId: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    const allocations: AllocationInput[] = [];
    for (const [k, v] of fd.entries()) {
      const m = /^alloc\.(document|payment)\.([0-9a-f-]{36})$/.exec(k);
      if (m && typeof v === "string" && v.trim()) allocations.push({ itemType: m[1] as "document" | "payment", itemId: m[2]!, amount: v.trim().replace(/[,\s$]/g, "") });
    }
    await recordPaymentFromTransaction(await orgCtx(slug), txnId, {
      kind: (str(fd, "kind") ?? "customer_payment") as PaymentKind,
      contactId: str(fd, "contactId") ?? "",
      allocations,
      feeAmount: str(fd, "feeAmount"),
      currency: str(fd, "currency"),
      memo: str(fd, "memo"),
    });
    refresh(slug);
  }, "Payment recorded and matched. No money was moved.");
}

export async function excludeAction(slug: string, ids: string[], _: unknown, fd: FormData): R {
  return runAction(async () => {
    const all = [...ids, ...fd.getAll("id").map(String)].filter(Boolean);
    await excludeTransactions(await orgCtx(slug), [...new Set(all)], str(fd, "reason") ?? "");
    refresh(slug);
  }, "Excluded.");
}

export async function restoreAction(slug: string, id: string): R {
  return runAction(async () => {
    await restoreTransaction(await orgCtx(slug), id);
    refresh(slug);
  }, "Restored to review.");
}

export async function undoMatchAction(slug: string, groupId: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await undoMatch(await orgCtx(slug), groupId, str(fd, "reason") ?? "");
    refresh(slug);
  }, "Undone. The transaction is back in review.");
}

export async function confirmReviewedAction(slug: string, ids: string[], _?: unknown, fd?: FormData): R {
  return runAction(async () => {
    const all = [...ids, ...(fd ? fd.getAll("id").map(String) : [])].filter(Boolean);
    await confirmReviewed(await orgCtx(slug), [...new Set(all)]);
    refresh(slug);
  }, "Confirmed.");
}

export async function bulkAcceptAction(slug: string, _: unknown, fd: FormData): R<{ accepted: number; skipped: number }> {
  const r = await runAction(async () => {
    const ids = fd.getAll("id").map(String).filter(Boolean);
    const res = await acceptSuggestions(await orgCtx(slug), ids);
    refresh(slug);
    return { accepted: res.accepted, skipped: res.skipped.length };
  });
  if (r.ok && r.data) {
    r.message = `Accepted ${r.data.accepted}.${r.data.skipped ? ` ${r.data.skipped} left for review (no single clear suggestion).` : ""}`;
  }
  return r;
}

export async function bulkExcludeAction(slug: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    const ids = fd.getAll("id").map(String).filter(Boolean);
    await excludeTransactions(await orgCtx(slug), ids, str(fd, "reason") ?? "");
    refresh(slug);
  }, "Excluded.");
}

// ── Reconciliation ──────────────────────────────────────────────────────────

export async function startReconciliationAction(slug: string, _: unknown, fd: FormData): R<{ href: string }> {
  return runAction(async () => {
    const rec = await startReconciliation(await orgCtx(slug), {
      accountId: str(fd, "accountId") ?? "",
      statementDate: str(fd, "statementDate") ?? "",
      statementBalance: str(fd, "statementBalance") ?? "",
    });
    refresh(slug);
    return { href: `/o/${slug}/banking/reconciliations/${rec.id}` };
  });
}

export async function saveClearedAction(slug: string, recId: string, lineIds: string[]): R<{ difference: string; cleared: string }> {
  return runAction(async () => {
    const s = await setCleared(await orgCtx(slug), recId, lineIds);
    return { difference: s.difference.toString(), cleared: s.cleared.toString() };
  });
}

export async function completeReconciliationAction(slug: string, recId: string, lineIds: string[], _: unknown, fd: FormData): R<{ href: string }> {
  return runAction(async () => {
    const ctx = await orgCtx(slug);
    await setCleared(ctx, recId, lineIds);
    await completeReconciliation(ctx, recId, { adjustReason: bool(fd, "adjust") ? str(fd, "reason") : null });
    refresh(slug);
    return { href: `/o/${slug}/banking/reconciliations/${recId}` };
  });
}

export async function cancelReconciliationAction(slug: string, recId: string): R<{ href: string }> {
  return runAction(async () => {
    await cancelReconciliation(await orgCtx(slug), recId);
    refresh(slug);
    return { href: `/o/${slug}/banking/reconciliations` };
  });
}

export async function undoReconciliationAction(slug: string, recId: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await undoReconciliation(await orgCtx(slug), recId, str(fd, "reason") ?? "");
    refresh(slug);
  }, "Reconciliation undone. Its items are uncleared.");
}

// ── Rules ───────────────────────────────────────────────────────────────────

export interface RulePayload {
  name: string;
  priority: number | null;
  conditions: BankRuleConditions;
  actions: BankRuleActions;
  mode: "suggest" | "auto_categorize";
  isActive: boolean;
}

export async function saveRuleAction(slug: string, id: string | null, payload: RulePayload): R<{ href: string; autoPostEffective: boolean }> {
  return runAction(async () => {
    const ctx = await orgCtx(slug);
    const input: RuleInput = payload;
    const { rule, autoPostEffective } = await saveRule(ctx, input, id);
    refresh(slug);
    return { href: `/o/${slug}/banking/rules/${rule.id}`, autoPostEffective };
  });
}

export async function previewRuleAction(slug: string, id: string | null, payload: RulePayload) {
  return runAction(async () => {
    const ctx = await orgCtx(slug);
    const rows = await previewRule(getDb(), ctx, { id, conditions: payload.conditions, actions: payload.actions, priority: payload.priority });
    return rows.map((r) => ({
      id: r.txn.id,
      date: r.txn.postedDate,
      description: r.txn.description,
      amount: r.txn.amount,
      currency: r.txn.currency,
      claimedBy: r.claimedBy,
      splits: r.splits?.map((s) => ({ accountId: s.accountId, amount: s.amount.toString() })) ?? null,
    }));
  });
}

export async function deleteRuleAction(slug: string, id: string): R<{ href: string }> {
  return runAction(async () => {
    await deleteRule(await orgCtx(slug), id);
    refresh(slug);
    return { href: `/o/${slug}/banking/rules` };
  });
}

export async function moveRuleAction(slug: string, id: string, direction: "up" | "down"): R {
  return runAction(async () => {
    await moveRule(await orgCtx(slug), id, direction);
    refresh(slug);
  });
}

export async function runRulesAction(slug: string): R<{ suggested: number; posted: number }> {
  return runAction(async () => {
    const r = await runRulesNow(await orgCtx(slug));
    refresh(slug);
    return r;
  });
}

// ── Feeds ───────────────────────────────────────────────────────────────────

export async function connectFeedAction(slug: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await connectFeed(await orgCtx(slug), { provider: (str(fd, "provider") ?? "sandbox") as "simplefin" | "sandbox", setupToken: str(fd, "setupToken") });
    revalidatePath(`/o/${slug}/settings/integrations`);
  }, "Connected. Link each feed account to a bank account, then sync.");
}

export async function linkFeedAction(slug: string, feedAccountId: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await linkFeedAccount(await orgCtx(slug), feedAccountId, str(fd, "accountId"));
    revalidatePath(`/o/${slug}/settings/integrations`);
  }, "Saved.");
}

export async function syncFeedAction(slug: string, connectionId: string): R<{ imported: number }> {
  const r = await runAction(async () => {
    const res = await syncConnection(await orgCtx(slug), connectionId);
    refresh(slug);
    revalidatePath(`/o/${slug}/settings/integrations`);
    return { imported: res.imported };
  });
  if (r.ok && r.data) r.message = r.data.imported ? `Synced: ${r.data.imported} new transaction${r.data.imported === 1 ? "" : "s"} waiting for review.` : "Synced: nothing new.";
  return r;
}

export async function refreshFeedAccountsAction(slug: string, connectionId: string): R {
  return runAction(async () => {
    await refreshFeedAccounts(await orgCtx(slug), connectionId);
    revalidatePath(`/o/${slug}/settings/integrations`);
  }, "Account list refreshed.");
}

export async function disconnectFeedAction(slug: string, connectionId: string): R {
  return runAction(async () => {
    await disconnectFeed(await orgCtx(slug), connectionId);
    revalidatePath(`/o/${slug}/settings/integrations`);
  }, "Disconnected. Transactions already imported stay.");
}
