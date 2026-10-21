"use server";

import { revalidatePath } from "next/cache";
import { createAccount, setAccountArchived, updateAccount, type AccountInput } from "@/lib/ledger/accounts";
import { deleteManualDraft, postManualDraft, postManualEntry, reverseManualEntry, saveManualDraft, type ManualEntryInput } from "@/lib/ledger/journals";
import { closePeriod, reopenPeriod, setLockDate, closeFiscalYear } from "@/lib/ledger/periods";
import { addManualRate, deleteRate } from "@/lib/fx/rates";
import { fetchRates } from "@/lib/fx/providers";
import { postRevaluation } from "@/lib/fx/revaluation";
import { createDimension, updateDimension } from "@/lib/ledger/dimensions";
import { postOpeningBalances } from "@/lib/ledger/opening-balances";
import { addTaxRate, createJurisdiction, deleteTaxRate, saveTaxCode, updateJurisdiction } from "@/lib/tax/config";
import { recordTaxRemittance, recordTaxAdjustment } from "@/lib/tax/remittance";
import { bool, runAction, str, type ActionResult } from "@/lib/web/actions";
import { orgCtx } from "@/lib/web/session";
import type { AccountSubtype } from "@/lib/db/schema/ledger";

type R<T = unknown> = Promise<ActionResult<T>>;

function accountInput(fd: FormData): AccountInput {
  return {
    code: str(fd, "code") ?? "",
    name: str(fd, "name") ?? "",
    subtype: (str(fd, "subtype") ?? "") as AccountSubtype,
    parentId: str(fd, "parentId"),
    description: str(fd, "description"),
    currency: str(fd, "currency"),
    cashFlowSection: (str(fd, "cashFlowSection") as AccountInput["cashFlowSection"]) ?? null,
    intercompanyOrgId: str(fd, "intercompanyOrgId"),
    bank: { institution: str(fd, "institution"), mask: str(fd, "mask") },
  };
}

export async function createAccountAction(slug: string, _: unknown, fd: FormData): R<{ href: string }> {
  return runAction(async () => {
    const ctx = await orgCtx(slug);
    const a = await createAccount(ctx, accountInput(fd));
    return { href: `/o/${slug}/accounting/accounts/${a.id}` };
  });
}

export async function updateAccountAction(slug: string, id: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    const ctx = await orgCtx(slug);
    await updateAccount(ctx, id, accountInput(fd));
    revalidatePath(`/o/${slug}/accounting/accounts`);
  }, "Saved.");
}

export async function archiveAccountAction(slug: string, id: string, archived: boolean): R {
  return runAction(async () => {
    await setAccountArchived(await orgCtx(slug), id, archived);
  }, archived ? "Archived." : "Restored.");
}

function manualInput(fd: FormData): ManualEntryInput {
  const lines: ManualEntryInput["lines"] = [];
  for (let i = 0; i < 500; i++) {
    if (!fd.has(`lines.${i}.accountId`)) break;
    lines.push({
      accountId: str(fd, `lines.${i}.accountId`) ?? "",
      debit: str(fd, `lines.${i}.debit`),
      credit: str(fd, `lines.${i}.credit`),
      description: str(fd, `lines.${i}.description`),
      contactId: str(fd, `lines.${i}.contactId`),
      currency: str(fd, `lines.${i}.currency`),
      fxRate: str(fd, `lines.${i}.fxRate`),
      projectId: str(fd, `lines.${i}.projectId`),
      classId: str(fd, `lines.${i}.classId`),
      departmentId: str(fd, `lines.${i}.departmentId`),
      locationId: str(fd, `lines.${i}.locationId`),
      fundId: str(fd, `lines.${i}.fundId`),
      trustComponent: str(fd, `lines.${i}.trustComponent`) as "principal" | "income" | null,
      beneficiaryId: str(fd, `lines.${i}.beneficiaryId`),
    });
  }
  return {
    entryDate: str(fd, "entryDate") ?? "",
    description: str(fd, "description") ?? "",
    reference: str(fd, "reference"),
    isAdjusting: bool(fd, "isAdjusting"),
    autoReverseOn: str(fd, "autoReverseOn"),
    lines,
  };
}

export async function saveJournalAction(slug: string, draftId: string | null, _: unknown, fd: FormData): R<{ href: string }> {
  return runAction(async () => {
    const ctx = await orgCtx(slug);
    const input = manualInput(fd);
    if (str(fd, "intent") === "post") {
      if (draftId) {
        await saveManualDraft(ctx, input, draftId);
        const r = await postManualDraft(ctx, draftId);
        return { href: `/o/${slug}/accounting/journal/${r.entry.id}` };
      }
      const r = await postManualEntry(ctx, input, { idempotencyKey: str(fd, "idempotencyKey") });
      return { href: `/o/${slug}/accounting/journal/${r.entry.id}` };
    }
    const id = await saveManualDraft(ctx, input, draftId);
    return { href: `/o/${slug}/accounting/journal/${id}` };
  });
}

export async function deleteDraftAction(slug: string, id: string): R<{ href: string }> {
  return runAction(async () => {
    await deleteManualDraft(await orgCtx(slug), id);
    return { href: `/o/${slug}/accounting/journal` };
  });
}

export async function postDraftAction(slug: string, id: string): R {
  return runAction(async () => {
    await postManualDraft(await orgCtx(slug), id);
  }, "Posted.");
}

export async function reverseEntryAction(slug: string, id: string, _: unknown, fd: FormData): R<{ href: string }> {
  return runAction(async () => {
    const r = await reverseManualEntry(await orgCtx(slug), id, { date: str(fd, "date") ?? "", reason: str(fd, "reason") ?? "" });
    return { href: `/o/${slug}/accounting/journal/${r.entry.id}` };
  });
}

export async function closePeriodAction(slug: string, periodId: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await closePeriod(await orgCtx(slug), periodId, { reason: str(fd, "reason"), acknowledgeWarnings: bool(fd, "acknowledge") });
  }, "Period closed.");
}

export async function closeYearAction(slug: string, fyId: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await closeFiscalYear(await orgCtx(slug), fyId, { reason: str(fd, "reason") ?? undefined, acknowledgeWarnings: true });
  }, "Fiscal year closed.");
}

export async function reopenPeriodAction(slug: string, periodId: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await reopenPeriod(await orgCtx(slug), periodId, str(fd, "reason") ?? "");
  }, "Period reopened.");
}

export async function lockDateAction(slug: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await setLockDate(await orgCtx(slug), str(fd, "lockDate"), str(fd, "reason") ?? "");
  }, "Lock date saved.");
}

export async function addRateAction(slug: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await addManualRate(await orgCtx(slug), { currency: str(fd, "currency") ?? "", rateDate: str(fd, "rateDate") ?? "", rate: str(fd, "rate") ?? "", note: str(fd, "note") });
  }, "Rate saved.");
}

export async function deleteRateAction(slug: string, id: string): R {
  return runAction(async () => {
    await deleteRate(await orgCtx(slug), id);
  }, "Rate deleted.");
}

export async function fetchRatesAction(slug: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    const r = await fetchRates(await orgCtx(slug), { from: str(fd, "from") ?? "", to: str(fd, "to") ?? "" });
    return r;
  }, "Rates fetched.");
}

export async function revalueAction(slug: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await postRevaluation(await orgCtx(slug), str(fd, "date") ?? "");
  }, "Revaluation posted. It reverses automatically the next day.");
}

export async function saveDimensionAction(slug: string, id: string | null, _: unknown, fd: FormData): R {
  return runAction(async () => {
    const ctx = await orgCtx(slug);
    const input = {
      kind: (str(fd, "kind") ?? "class") as "class" | "department" | "location" | "fund",
      name: str(fd, "name") ?? "",
      code: str(fd, "code"),
      parentId: str(fd, "parentId"),
      restriction: str(fd, "restriction") as never,
      isArchived: bool(fd, "isArchived"),
    };
    if (id) await updateDimension(ctx, id, input);
    else await createDimension(ctx, input);
  }, "Saved.");
}

export async function openingBalancesAction(slug: string, _: unknown, fd: FormData): R<{ href: string }> {
  return runAction(async () => {
    const ctx = await orgCtx(slug);
    const lines: { accountId: string; debit: string | null; credit: string | null }[] = [];
    for (const [k, v] of fd.entries()) {
      const m = /^bal\.([0-9a-f-]{36})\.(debit|credit)$/.exec(k);
      if (!m || typeof v !== "string" || !v.trim()) continue;
      let line = lines.find((l) => l.accountId === m[1]);
      if (!line) lines.push((line = { accountId: m[1]!, debit: null, credit: null }));
      line[m[2] as "debit" | "credit"] = v.trim();
    }
    const r = await postOpeningBalances(ctx, { asOf: str(fd, "asOf") ?? "", lines });
    return { href: `/o/${slug}/accounting/journal/${r.entry.id}` };
  });
}

export async function createJurisdictionAction(slug: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await createJurisdiction(await orgCtx(slug), {
      name: str(fd, "name") ?? "",
      code: str(fd, "code"),
      liabilityAccountId: str(fd, "liabilityAccountId"),
      recoverableAccountId: str(fd, "recoverableAccountId"),
      authorityContactId: str(fd, "authorityContactId"),
      filingFrequency: str(fd, "filingFrequency") as never,
    });
  }, "Jurisdiction added.");
}

export async function updateJurisdictionAction(slug: string, id: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await updateJurisdiction(await orgCtx(slug), id, {
      name: str(fd, "name") ?? "",
      code: str(fd, "code"),
      liabilityAccountId: str(fd, "liabilityAccountId") ?? "",
      recoverableAccountId: str(fd, "recoverableAccountId"),
      authorityContactId: str(fd, "authorityContactId"),
      filingFrequency: str(fd, "filingFrequency") as never,
      isArchived: bool(fd, "isArchived"),
    });
  }, "Saved.");
}

export async function addTaxRateAction(slug: string, jurisdictionId: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await addTaxRate(await orgCtx(slug), {
      jurisdictionId,
      name: str(fd, "name") ?? "",
      rate: str(fd, "rate") ?? "",
      effectiveFrom: str(fd, "effectiveFrom") ?? "",
      effectiveTo: str(fd, "effectiveTo"),
      sourceNote: str(fd, "sourceNote"),
    });
  }, "Rate added.");
}

export async function deleteTaxRateAction(slug: string, id: string): R {
  return runAction(async () => {
    await deleteTaxRate(await orgCtx(slug), id);
  }, "Rate deleted.");
}

export async function saveTaxCodeAction(slug: string, id: string | null, _: unknown, fd: FormData): R {
  return runAction(async () => {
    const components: { jurisdictionId: string; isCompound: boolean }[] = [];
    for (let i = 0; i < 10; i++) {
      const j = str(fd, `components.${i}.jurisdictionId`);
      if (j) components.push({ jurisdictionId: j, isCompound: bool(fd, `components.${i}.isCompound`) });
    }
    await saveTaxCode(await orgCtx(slug), { id, name: str(fd, "name") ?? "", description: str(fd, "description"), isExempt: bool(fd, "isExempt"), components, isArchived: bool(fd, "isArchived") });
  }, "Tax code saved.");
}

export async function remitTaxAction(slug: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await recordTaxRemittance(await orgCtx(slug), {
      jurisdictionId: str(fd, "jurisdictionId") ?? "",
      date: str(fd, "date") ?? "",
      amount: str(fd, "amount") ?? "",
      paidFromAccountId: str(fd, "paidFromAccountId") ?? "",
      periodStart: str(fd, "periodStart"),
      periodEnd: str(fd, "periodEnd"),
      reference: str(fd, "reference"),
    });
  }, "Remittance recorded. No money was sent by Gideon Books.");
}

export async function adjustTaxAction(slug: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await recordTaxAdjustment(await orgCtx(slug), {
      jurisdictionId: str(fd, "jurisdictionId") ?? "",
      date: str(fd, "date") ?? "",
      amount: str(fd, "amount") ?? "",
      offsetAccountId: str(fd, "offsetAccountId") ?? "",
      reason: str(fd, "reason") ?? "",
    });
  }, "Adjustment posted.");
}

export async function openingDocumentAction(slug: string, kind: "invoice" | "bill", _: unknown, fd: FormData): R {
  return runAction(async () => {
    const { createOpeningDocument } = await import("@/lib/ledger/opening-balances");
    await createOpeningDocument(await orgCtx(slug), {
      kind,
      contactId: str(fd, "contactId") ?? "",
      reference: str(fd, "reference"),
      issueDate: str(fd, "issueDate") ?? "",
      dueDate: str(fd, "dueDate"),
      amount: str(fd, "amount") ?? "",
      currency: str(fd, "currency"),
      fxRate: str(fd, "fxRate"),
    });
  }, kind === "invoice" ? "Opening invoice posted." : "Opening bill posted.");
}
