/** Options for the fixed-asset form, built on the server. */
import type { DbOrTx } from "@/lib/db/client";
import type { Ctx } from "@/lib/context";
import { accountOptions, dimensionOptions } from "@/lib/web/options";
import { getSystemAccountReadOnly, listAccounts } from "@/lib/ledger/accounts";
import { formatMoney, formatDate } from "@/lib/money/format";
import { assetCategories, capitalizableLines, type FixedAsset } from "./assets";
import type { AssetFormDefaults } from "@/components/assets/asset-form";
import { Decimal } from "@/lib/money/decimal";

export async function assetFormOptions(db: DbOrTx, ctx: Ctx) {
  const all = await accountOptions(db, ctx.orgId);
  const accountsRaw = await listAccounts(db, ctx.orgId);
  const bySubtype = (sub: string) => accountsRaw.filter((a) => a.subtype === sub).map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` }));
  const lines = await capitalizableLines(db, ctx.orgId);
  const dims = await dimensionOptions(db, ctx.orgId);
  return {
    assetAccounts: bySubtype("fixed_asset"),
    accumulatedAccounts: bySubtype("accumulated_depreciation"),
    expenseAccounts: accountsRaw.filter((a) => a.type === "expense").map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` })),
    fundingAccounts: all.filter((o) => {
      const a = accountsRaw.find((x) => x.id === o.value);
      return a && !a.control && ["asset", "liability", "equity"].includes(a.type) && a.subtype !== "fixed_asset" && a.subtype !== "accumulated_depreciation";
    }),
    lines: lines.map((l) => ({
        lineId: l.lineId,
        label: `${formatDate(l.date)} · ${l.documentKind === "bill" ? "Bill" : "Expense"} ${l.documentNumber ?? ""} · ${l.description || "(no description)"} · ${formatMoney(Decimal.from(l.amount).toString(), ctx.org.baseCurrency)}`,
        amount: Decimal.from(l.amount).normalize().toString(),
        accountId: l.accountId,
        date: l.date,
        description: l.description,
    })),
    dims: { classes: dims.classes, departments: dims.departments, locations: dims.locations, projects: dims.projects },
    categories: await assetCategories(db, ctx.orgId),
  };
}

export async function defaultsForNew(db: DbOrTx, ctx: Ctx, today: string): Promise<AssetFormDefaults> {
  const fa = await getSystemAccountReadOnly(db, ctx.orgId, "fixed_assets");
  const ad = await getSystemAccountReadOnly(db, ctx.orgId, "accumulated_depreciation");
  const de = await getSystemAccountReadOnly(db, ctx.orgId, "depreciation_expense");
  return {
    name: "",
    category: "",
    description: "",
    assetAccountId: fa?.id ?? "",
    accumulatedDepreciationAccountId: ad?.id ?? "",
    depreciationExpenseAccountId: de?.id ?? "",
    acquisitionDate: today,
    inServiceDate: "",
    cost: "",
    residualValue: "0",
    usefulLifeMonths: "60",
    method: "straight_line",
    decliningFactor: "2",
    acquisitionType: "direct",
    sourceDocumentLineId: "",
    fundingAccountId: "",
    openingAccumulatedDepreciation: "",
    openingDepreciationThrough: "",
    classId: "",
    departmentId: "",
    locationId: "",
    projectId: "",
    notes: "",
  };
}

export function defaultsFromAsset(a: FixedAsset): AssetFormDefaults {
  const n = (v: string | null) => (v ? Decimal.from(v).normalize().toString() : "");
  return {
    name: a.name,
    category: a.category ?? "",
    description: a.description ?? "",
    assetAccountId: a.assetAccountId,
    accumulatedDepreciationAccountId: a.accumulatedDepreciationAccountId,
    depreciationExpenseAccountId: a.depreciationExpenseAccountId,
    acquisitionDate: a.acquisitionDate,
    inServiceDate: a.inServiceDate,
    cost: n(a.cost),
    residualValue: n(a.residualValue),
    usefulLifeMonths: String(a.usefulLifeMonths),
    method: a.method,
    decliningFactor: n(a.decliningFactor),
    acquisitionType: a.acquisitionType,
    sourceDocumentLineId: a.sourceDocumentLineId ?? "",
    fundingAccountId: a.fundingAccountId ?? "",
    openingAccumulatedDepreciation: n(a.openingAccumulatedDepreciation),
    openingDepreciationThrough: a.openingDepreciationThrough ?? "",
    classId: a.classId ?? "",
    departmentId: a.departmentId ?? "",
    locationId: a.locationId ?? "",
    projectId: a.projectId ?? "",
    notes: a.notes ?? "",
  };
}
