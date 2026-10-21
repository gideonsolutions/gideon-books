"use server";

import { addCustomCategory, assertReturnType, confirmAllMappings, saveMappings, suggestMappings, type DimensionKind, type MappingChange } from "@/lib/taxexport/mappings";
import { addAdjustment, importDepreciationAdjustments, voidAdjustment } from "@/lib/taxexport/adjustments";
import { recordReview } from "@/lib/taxexport/reconcile";
import { generateExport } from "@/lib/taxexport/export";
import type { CategoryKind } from "@/lib/taxexport/catalogs";
import { bool, runAction, str, type ActionResult } from "@/lib/web/actions";
import { orgCtx } from "@/lib/web/session";
import { ValidationError } from "@/lib/errors";

type R<T = unknown> = Promise<ActionResult<T>>;

function selection(fd: FormData) {
  return {
    returnType: assertReturnType(str(fd, "rt") ?? ""),
    taxYearStart: str(fd, "yearStart") ?? "",
    taxYearEnd: str(fd, "yearEnd") ?? "",
    basis: (str(fd, "basis") === "cash" ? "cash" : "accrual") as "cash" | "accrual",
  };
}

export async function saveMappingsAction(slug: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    const ctx = await orgCtx(slug);
    const rt = assertReturnType(str(fd, "rt") ?? "");
    const changes: MappingChange[] = [];
    const seen = new Set<string>();
    for (const [k] of fd.entries()) {
      const m = /^map\|([0-9a-f-]{36})\|(.*)$/.exec(k);
      if (!m || seen.has(k)) continue;
      seen.add(k);
      const [kind, value] = m[2] ? (m[2].split(":") as [DimensionKind, string]) : [null, null];
      const code = str(fd, k);
      const before = str(fd, `orig|${m[1]}|${m[2]}`);
      const confirm = bool(fd, `ok|${m[1]}|${m[2]}`);
      const wasConfirmed = str(fd, `origok|${m[1]}|${m[2]}`) === "1";
      if (code === before && confirm === wasConfirmed) continue;
      changes.push({ accountId: m[1]!, dimensionKind: kind, dimensionValueId: value, categoryCode: code, confirm });
    }
    await saveMappings(ctx, rt, changes);
  }, "Mappings saved.");
}

export async function addDimensionMappingAction(slug: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    const ctx = await orgCtx(slug);
    const rt = assertReturnType(str(fd, "rt") ?? "");
    await saveMappings(ctx, rt, [
      {
        accountId: str(fd, "accountId") ?? "",
        dimensionKind: str(fd, "dimensionKind") as DimensionKind,
        dimensionValueId: str(fd, "dimensionValueId"),
        categoryCode: str(fd, "categoryCode"),
        confirm: true,
      },
    ]);
  }, "Mapping added.");
}

export async function suggestAction(slug: string, rt: string): R {
  return runAction(async () => {
    const n = await suggestMappings(await orgCtx(slug), assertReturnType(rt));
    return { suggested: n };
  }, "Suggestions added. Check each one and confirm it.");
}

export async function confirmAllAction(slug: string, rt: string): R {
  return runAction(async () => {
    await confirmAllMappings(await orgCtx(slug), assertReturnType(rt));
  }, "All mappings confirmed.");
}

export async function addCategoryAction(slug: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await addCustomCategory(await orgCtx(slug), {
      returnType: assertReturnType(str(fd, "rt") ?? ""),
      code: str(fd, "code") ?? "",
      description: str(fd, "description") ?? "",
      kind: (str(fd, "kind") ?? "deduction") as CategoryKind,
    });
  }, "Category added.");
}

export async function addAdjustmentAction(slug: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    const s = selection(fd);
    await addAdjustment(await orgCtx(slug), {
      returnType: s.returnType,
      taxYearStart: s.taxYearStart,
      taxYearEnd: s.taxYearEnd,
      categoryCode: str(fd, "categoryCode") ?? "",
      kind: (str(fd, "kind") ?? "permanent") as "permanent" | "temporary",
      amount: str(fd, "amount") ?? "",
      description: str(fd, "description") ?? "",
      source: (str(fd, "source") ?? "manual") as "manual",
    });
  }, "Adjustment added.");
}

export async function voidAdjustmentAction(slug: string, id: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await voidAdjustment(await orgCtx(slug), id, str(fd, "reason") ?? "");
  }, "Adjustment removed.");
}

export async function importDepreciationAction(slug: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    const s = selection(fd);
    const r = await importDepreciationAdjustments(await orgCtx(slug), { ...s, categoryCode: str(fd, "categoryCode") ?? "" });
    if (!r.available) throw new ValidationError("The fixed-asset register does not provide tax depreciation yet.");
    return r;
  }, "Depreciation differences imported.");
}

export async function reviewAction(slug: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    const s = selection(fd);
    await recordReview(await orgCtx(slug), { ...s, status: str(fd, "status") === "approved" ? "approved" : "reviewed", note: str(fd, "note") });
  }, "Recorded.");
}

export async function exportAction(slug: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    const r = await generateExport(await orgCtx(slug), selection(fd));
    return { reused: r.reused };
  }, "Export package ready below.");
}
