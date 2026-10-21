"use server";

import { capitalizeAsset, createAsset, deleteDraftAsset, disposeAsset, reverseDisposal, updateAsset, type AssetInput } from "@/lib/assets/assets";
import { discardRun, postRun, prepareRun, reverseRun, setAutoPostDepreciation } from "@/lib/assets/depreciation";
import { saveTaxBook, setEnteredTaxDepreciation } from "@/lib/assets/tax-book";
import { bool, runAction, str, type ActionResult } from "@/lib/web/actions";
import { orgCtx } from "@/lib/web/session";

type R<T = unknown> = Promise<ActionResult<T>>;

function assetInput(fd: FormData): AssetInput {
  return {
    name: str(fd, "name") ?? "",
    category: str(fd, "category"),
    description: str(fd, "description"),
    assetAccountId: str(fd, "assetAccountId"),
    accumulatedDepreciationAccountId: str(fd, "accumulatedDepreciationAccountId"),
    depreciationExpenseAccountId: str(fd, "depreciationExpenseAccountId"),
    acquisitionDate: str(fd, "acquisitionDate") ?? "",
    inServiceDate: str(fd, "inServiceDate"),
    cost: str(fd, "cost") ?? "",
    residualValue: str(fd, "residualValue"),
    usefulLifeMonths: Number(str(fd, "usefulLifeYears") ? Math.round(Number(str(fd, "usefulLifeYears")) * 12) : (str(fd, "usefulLifeMonths") ?? "0")),
    method: (str(fd, "method") ?? "straight_line") as AssetInput["method"],
    decliningFactor: str(fd, "decliningFactor"),
    acquisitionType: (str(fd, "acquisitionType") ?? "direct") as AssetInput["acquisitionType"],
    sourceDocumentLineId: str(fd, "sourceDocumentLineId"),
    fundingAccountId: str(fd, "fundingAccountId"),
    openingAccumulatedDepreciation: str(fd, "openingAccumulatedDepreciation"),
    openingDepreciationThrough: str(fd, "openingDepreciationThrough"),
    classId: str(fd, "classId"),
    departmentId: str(fd, "departmentId"),
    locationId: str(fd, "locationId"),
    projectId: str(fd, "projectId"),
    notes: str(fd, "notes"),
  };
}

export async function createAssetAction(slug: string, _: unknown, fd: FormData): R<{ href: string }> {
  return runAction(async () => {
    const ctx = await orgCtx(slug);
    const a = await createAsset(ctx, assetInput(fd));
    if (str(fd, "intent") === "capitalize") await capitalizeAsset(ctx, a.id);
    return { href: `/o/${slug}/assets/${a.id}` };
  });
}

export async function updateAssetAction(slug: string, id: string, _: unknown, fd: FormData): R<{ href: string }> {
  return runAction(async () => {
    const ctx = await orgCtx(slug);
    await updateAsset(ctx, id, assetInput(fd));
    if (str(fd, "intent") === "capitalize") await capitalizeAsset(ctx, id);
    return { href: `/o/${slug}/assets/${id}` };
  });
}

export async function capitalizeAssetAction(slug: string, id: string): R {
  return runAction(async () => {
    await capitalizeAsset(await orgCtx(slug), id);
  }, "Capitalized: the asset is on the books.");
}

export async function deleteAssetAction(slug: string, id: string): R<{ href: string }> {
  return runAction(async () => {
    await deleteDraftAsset(await orgCtx(slug), id);
    return { href: `/o/${slug}/assets` };
  });
}

export async function disposeAssetAction(slug: string, id: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await disposeAsset(await orgCtx(slug), id, { date: str(fd, "date") ?? "", proceeds: str(fd, "proceeds"), proceedsAccountId: str(fd, "proceedsAccountId"), reason: str(fd, "reason") ?? "" });
  }, "Disposal posted.");
}

export async function reverseDisposalAction(slug: string, id: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await reverseDisposal(await orgCtx(slug), id, { date: str(fd, "date") ?? "", reason: str(fd, "reason") ?? "" });
  }, "Disposal reversed; the asset is active again.");
}

export async function prepareRunAction(slug: string, _: unknown, fd: FormData): R<{ href: string }> {
  return runAction(async () => {
    const run = await prepareRun(await orgCtx(slug), str(fd, "periodEnd") ?? "");
    return { href: `/o/${slug}/assets/depreciation/${run.id}` };
  });
}

export async function postRunAction(slug: string, id: string): R {
  return runAction(async () => {
    await postRun(await orgCtx(slug), id);
  }, "Depreciation posted.");
}

export async function discardRunAction(slug: string, id: string): R<{ href: string }> {
  return runAction(async () => {
    await discardRun(await orgCtx(slug), id);
    return { href: `/o/${slug}/assets/depreciation` };
  });
}

export async function reverseRunAction(slug: string, id: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await reverseRun(await orgCtx(slug), id, { date: str(fd, "date"), reason: str(fd, "reason") ?? "" });
  }, "Run reversed; its months can be depreciated again.");
}

export async function autoPostAction(slug: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await setAutoPostDepreciation(await orgCtx(slug), bool(fd, "autoPost"));
  }, "Saved.");
}

export async function saveTaxBookAction(slug: string, assetId: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    const years = str(fd, "taxLifeYears");
    await saveTaxBook(await orgCtx(slug), assetId, {
      method: (str(fd, "method") ?? "straight_line") as "straight_line" | "declining_balance" | "entered",
      methodLabel: str(fd, "methodLabel"),
      taxBasis: str(fd, "taxBasis") ?? "",
      usefulLifeMonths: years ? Math.round(Number(years) * 12) : null,
      decliningFactor: str(fd, "decliningFactor"),
      placedInService: str(fd, "placedInService") ?? "",
      notes: str(fd, "notes"),
    });
  }, "Tax book saved. It does not post to the ledger.");
}

export async function enterTaxDepreciationAction(slug: string, assetId: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await setEnteredTaxDepreciation(await orgCtx(slug), assetId, {
      taxYearStart: str(fd, "taxYearStart") ?? "",
      taxYearEnd: str(fd, "taxYearEnd") ?? "",
      amount: str(fd, "amount") ?? "",
      note: str(fd, "note"),
    });
  }, "Tax depreciation recorded.");
}
