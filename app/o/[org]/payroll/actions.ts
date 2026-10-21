"use server";

import { createImport, discardImport, postImport, voidRun } from "@/lib/payroll/imports";
import { deleteMapping, saveMapping } from "@/lib/payroll/mappings";
import { recordLiabilityPayment, recordNetPay, voidSettlement } from "@/lib/payroll/settlements";
import { ValidationError } from "@/lib/errors";
import { runAction, str, type ActionResult } from "@/lib/web/actions";
import { orgCtx } from "@/lib/web/session";
import type { PayrollComponentType } from "@/lib/db/schema/payroll";

type R<T = unknown> = Promise<ActionResult<T>>;

export async function uploadPayrollAction(slug: string, _: unknown, fd: FormData): R<{ href: string }> {
  return runAction(async () => {
    const ctx = await orgCtx(slug);
    const file = fd.get("file");
    const pasted = str(fd, "content");
    let content: string;
    let fileName: string;
    if (file instanceof File && file.size > 0) {
      if (file.size > 5 * 1024 * 1024) throw new ValidationError("Payroll files can be at most 5 MB.", { file: "Too large." });
      content = await file.text();
      fileName = file.name;
    } else if (pasted) {
      content = pasted;
      fileName = "pasted";
    } else {
      throw new ValidationError("Choose the payroll file.", { file: "Required." });
    }
    const imp = await createImport(ctx, { adapter: str(fd, "adapter") ?? "generic_csv", fileName, content });
    return { href: `/o/${slug}/payroll/imports/${imp.id}` };
  });
}

export async function postPayrollImportAction(slug: string, importId: string): R<{ href: string }> {
  return runAction(async () => {
    const run = await postImport(await orgCtx(slug), importId);
    return { href: `/o/${slug}/payroll/${run.id}` };
  });
}

export async function discardPayrollImportAction(slug: string, importId: string): R<{ href: string }> {
  return runAction(async () => {
    await discardImport(await orgCtx(slug), importId);
    return { href: `/o/${slug}/payroll/import` };
  });
}

export async function voidPayrollRunAction(slug: string, runId: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await voidRun(await orgCtx(slug), runId, { date: str(fd, "date") ?? "", reason: str(fd, "reason") ?? "" });
  }, "Run voided. Import the corrected file when ready.");
}

export async function recordNetPayAction(slug: string, runId: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await recordNetPay(await orgCtx(slug), runId, { date: str(fd, "date") ?? "", bankAccountId: str(fd, "bankAccountId") ?? "", amount: str(fd, "amount"), reference: str(fd, "reference") });
  }, "Net pay recorded. No money was moved by Gideon Books.");
}

export async function recordLiabilityPaymentAction(slug: string, runId: string | null, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await recordLiabilityPayment(await orgCtx(slug), {
      runId: runId ?? str(fd, "runId"),
      liabilityAccountId: str(fd, "liabilityAccountId") ?? "",
      date: str(fd, "date") ?? "",
      bankAccountId: str(fd, "bankAccountId") ?? "",
      amount: str(fd, "amount") ?? "",
      reference: str(fd, "reference"),
      memo: str(fd, "memo"),
    });
  }, "Payment recorded. No money was moved by Gideon Books.");
}

export async function voidPayrollSettlementAction(slug: string, settlementId: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await voidSettlement(await orgCtx(slug), settlementId, { date: str(fd, "date") ?? "", reason: str(fd, "reason") ?? "" });
  }, "Voided.");
}

export async function saveMappingAction(slug: string, id: string | null, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await saveMapping(
      await orgCtx(slug),
      {
        componentType: (str(fd, "componentType") ?? "") as PayrollComponentType,
        componentCode: str(fd, "componentCode") ?? "",
        label: str(fd, "label"),
        expenseAccountId: str(fd, "expenseAccountId"),
        liabilityAccountId: str(fd, "liabilityAccountId"),
      },
      id,
    );
  }, "Mapping saved.");
}

export async function deleteMappingAction(slug: string, id: string): R {
  return runAction(async () => {
    await deleteMapping(await orgCtx(slug), id);
  }, "Mapping deleted.");
}
