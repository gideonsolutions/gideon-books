/**
 * Book-to-tax adjustments: differences between the books and the return
 * (the nondeductible half of meals, tax depreciation instead of book
 * depreciation, …). They live only here and in the export; they never post
 * to the ledger, so the books stay the books.
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import { getDb, withTransaction, type DbOrTx } from "@/lib/db/client";
import { taxAdjustments, type TaxReturnType } from "@/lib/db/schema/taxexport";
import { audit } from "@/lib/audit";
import { requirePermission, type Ctx } from "@/lib/context";
import { NotFoundError, ValidationError, ConflictError } from "@/lib/errors";
import { Decimal } from "@/lib/money/decimal";
import { minorUnits } from "@/lib/money/currency";
import { isIsoDate } from "@/lib/dates";
import { allCategories } from "./mappings";

export type TaxAdjustment = typeof taxAdjustments.$inferSelect;

export async function listAdjustments(db: DbOrTx, orgId: string, returnType: TaxReturnType, yearStart: string, yearEnd: string, opts: { includeVoided?: boolean } = {}) {
  const conds = [eq(taxAdjustments.orgId, orgId), eq(taxAdjustments.returnType, returnType), eq(taxAdjustments.taxYearStart, yearStart), eq(taxAdjustments.taxYearEnd, yearEnd)];
  if (!opts.includeVoided) conds.push(isNull(taxAdjustments.voidedAt));
  return db.select().from(taxAdjustments).where(and(...conds)).orderBy(asc(taxAdjustments.createdAt));
}

export interface AdjustmentInput {
  returnType: TaxReturnType;
  taxYearStart: string;
  taxYearEnd: string;
  categoryCode: string;
  kind: "permanent" | "temporary";
  amount: string;
  description: string;
  source?: TaxAdjustment["source"];
  sourceRef?: string | null;
}

export async function addAdjustment(ctx: Ctx, input: AdjustmentInput): Promise<TaxAdjustment> {
  requirePermission(ctx, "tax_export.manage");
  const fields: Record<string, string> = {};
  if (!isIsoDate(input.taxYearStart) || !isIsoDate(input.taxYearEnd) || input.taxYearEnd < input.taxYearStart) fields.taxYear = "Choose the tax year.";
  const amount = Decimal.tryFrom((input.amount ?? "").replace(/[,\s$]/g, ""));
  if (!amount || amount.isZero()) fields.amount = "Enter a non-zero amount.";
  else if (amount.decimalPlaces > minorUnits(ctx.org.baseCurrency)) fields.amount = "Too many decimal places.";
  if (!input.description?.trim()) fields.description = "Say what the adjustment is for.";
  if (!["permanent", "temporary"].includes(input.kind)) fields.kind = "Permanent or temporary.";
  if (Object.keys(fields).length) throw new ValidationError("Check the adjustment.", fields);
  return withTransaction(async (tx) => {
    const cats = await allCategories(tx, ctx.orgId, input.returnType);
    if (!cats.some((c) => c.code === input.categoryCode)) throw new ValidationError("Choose a category.", { categoryCode: "Unknown category." });
    const [row] = await tx
      .insert(taxAdjustments)
      .values({
        orgId: ctx.orgId,
        returnType: input.returnType,
        taxYearStart: input.taxYearStart,
        taxYearEnd: input.taxYearEnd,
        categoryCode: input.categoryCode,
        kind: input.kind,
        amount: amount!.toString(),
        description: input.description.trim(),
        source: input.source ?? "manual",
        sourceRef: input.sourceRef ?? null,
        createdBy: ctx.actor.userId,
      })
      .returning();
    await audit(tx, ctx, { action: "tax_export.adjustment_added", entityType: "tax_adjustment", entityId: row!.id, after: row });
    return row!;
  });
}

export async function voidAdjustment(ctx: Ctx, id: string, reason: string) {
  requirePermission(ctx, "tax_export.manage");
  if (!reason?.trim()) throw new ValidationError("Say why the adjustment is being removed.", { reason: "Required." });
  await withTransaction(async (tx) => {
    const [a] = await tx.select().from(taxAdjustments).where(and(eq(taxAdjustments.orgId, ctx.orgId), eq(taxAdjustments.id, id))).for("update");
    if (!a) throw new NotFoundError("The adjustment");
    if (a.voidedAt) throw new ConflictError("Already removed.", "already_void");
    await tx.update(taxAdjustments).set({ voidedAt: new Date(), voidedBy: ctx.actor.userId, voidReason: reason.trim() }).where(eq(taxAdjustments.id, id));
    await audit(tx, ctx, { action: "tax_export.adjustment_voided", entityType: "tax_adjustment", entityId: id, reason: reason.trim() });
  });
}

export interface DepreciationDifference {
  assetId: string;
  assetName: string;
  bookDepreciation: string;
  taxDepreciation: string;
  difference: string;
}

/**
 * Book and tax depreciation per asset from the fixed-asset register's tax
 * book, or null when the register does not provide it.
 */
export async function depreciationDifferences(db: DbOrTx, orgId: string, yearStart: string, yearEnd: string): Promise<DepreciationDifference[] | null> {
  try {
    const mod = await import("@/lib/assets/tax-book");
    if (typeof mod.taxDepreciationDifferences !== "function") return null;
    return await mod.taxDepreciationDifferences(db, orgId, yearStart, yearEnd);
  } catch {
    return null;
  }
}

/**
 * Turn each asset's tax-minus-book depreciation into a temporary adjustment
 * on the depreciation category. Earlier depreciation adjustments for the
 * year are removed first, so running it again replaces rather than doubles.
 */
export async function importDepreciationAdjustments(ctx: Ctx, input: { returnType: TaxReturnType; taxYearStart: string; taxYearEnd: string; categoryCode: string }): Promise<{ created: number; available: boolean }> {
  requirePermission(ctx, "tax_export.manage");
  const diffs = await depreciationDifferences(getDb(), ctx.orgId, input.taxYearStart, input.taxYearEnd);
  if (diffs === null) return { created: 0, available: false };
  const old = (await listAdjustments(getDb(), ctx.orgId, input.returnType, input.taxYearStart, input.taxYearEnd)).filter((a) => a.source === "depreciation");
  for (const a of old) await voidAdjustment(ctx, a.id, "Replaced by a new import of tax depreciation");
  let created = 0;
  for (const d of diffs) {
    if (Decimal.from(d.difference).isZero()) continue;
    await addAdjustment(ctx, {
      returnType: input.returnType,
      taxYearStart: input.taxYearStart,
      taxYearEnd: input.taxYearEnd,
      categoryCode: input.categoryCode,
      kind: "temporary",
      amount: d.difference,
      description: `Tax depreciation ${d.taxDepreciation} vs book ${d.bookDepreciation} — ${d.assetName}`,
      source: "depreciation",
      sourceRef: d.assetId,
    });
    created++;
  }
  return { created, available: true };
}
