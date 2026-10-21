/**
 * The tax book: how each asset is depreciated for income tax, kept apart
 * from the books. Tax depreciation never posts to the ledger; the difference
 * between book and tax depreciation is a book-to-tax adjustment for the
 * Gideon Tax export (lib/taxexport).
 *
 * The method label (for example "MACRS 5-year, half-year") is the person's
 * own record. Gideon Books does not implement MACRS tables or conventions:
 * tax amounts are either computed here by simple straight-line or declining
 * balance on the tax basis, or entered per tax year from the preparer's
 * figures.
 */
import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import { withTransaction, type DbOrTx } from "@/lib/db/client";
import { assetTaxBooks, assetTaxDepreciation, fixedAssets } from "@/lib/db/schema/assets";
import { organizations } from "@/lib/db/schema/core";
import { audit } from "@/lib/audit";
import { requirePermission, type Ctx } from "@/lib/context";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { Decimal } from "@/lib/money/decimal";
import { minorUnits } from "@/lib/money/currency";
import { isIsoDate } from "@/lib/dates";
import { computeSchedule, sumBetween } from "./schedule";

export type AssetTaxBook = typeof assetTaxBooks.$inferSelect;

export interface TaxBookInput {
  method: AssetTaxBook["method"];
  methodLabel?: string | null;
  taxBasis: string;
  usefulLifeMonths?: number | null;
  decliningFactor?: string | null;
  placedInService: string;
  notes?: string | null;
}

export async function getTaxBook(db: DbOrTx, orgId: string, assetId: string) {
  const [book] = await db.select().from(assetTaxBooks).where(and(eq(assetTaxBooks.orgId, orgId), eq(assetTaxBooks.assetId, assetId)));
  const entered = await db
    .select()
    .from(assetTaxDepreciation)
    .where(and(eq(assetTaxDepreciation.orgId, orgId), eq(assetTaxDepreciation.assetId, assetId)))
    .orderBy(asc(assetTaxDepreciation.taxYearStart));
  return { book: book ?? null, entered };
}

export async function saveTaxBook(ctx: Ctx, assetId: string, input: TaxBookInput): Promise<AssetTaxBook> {
  requirePermission(ctx, "assets.manage");
  const fields: Record<string, string> = {};
  if (!["straight_line", "declining_balance", "entered"].includes(input.method)) fields.method = "Choose how tax depreciation is figured.";
  const basis = Decimal.tryFrom(input.taxBasis?.replace(/[,\s$]/g, ""));
  if (!basis || basis.isNegative()) fields.taxBasis = "Enter the tax basis.";
  if (!isIsoDate(input.placedInService)) fields.placedInService = "Enter the date placed in service for tax.";
  if (input.method !== "entered" && (!input.usefulLifeMonths || input.usefulLifeMonths < 1 || input.usefulLifeMonths > 1200)) fields.usefulLifeMonths = "Enter the tax life in months.";
  let factor: Decimal | null = null;
  if (input.method === "declining_balance") {
    factor = Decimal.tryFrom(input.decliningFactor ?? "2") ?? null;
    if (!factor || !factor.isPositive() || factor.gt(4)) fields.decliningFactor = "Use a factor between 0 and 4.";
  }
  if (Object.keys(fields).length) throw new ValidationError("Check the tax book.", fields);
  return withTransaction(async (tx) => {
    const [asset] = await tx.select().from(fixedAssets).where(and(eq(fixedAssets.orgId, ctx.orgId), eq(fixedAssets.id, assetId)));
    if (!asset) throw new NotFoundError("The asset");
    const values = {
      method: input.method,
      methodLabel: input.methodLabel?.trim() || null,
      taxBasis: basis!.toString(),
      usefulLifeMonths: input.method === "entered" ? null : (input.usefulLifeMonths ?? null),
      decliningFactor: factor?.toString() ?? null,
      placedInService: input.placedInService,
      notes: input.notes?.trim() || null,
      updatedBy: ctx.actor.userId,
      updatedAt: new Date(),
    };
    const [row] = await tx
      .insert(assetTaxBooks)
      .values({ orgId: ctx.orgId, assetId, ...values })
      .onConflictDoUpdate({ target: [assetTaxBooks.orgId, assetTaxBooks.assetId], set: values })
      .returning();
    await audit(tx, ctx, { action: "asset.tax_book_saved", entityType: "asset", entityId: assetId, after: row });
    return row!;
  });
}

export async function setEnteredTaxDepreciation(ctx: Ctx, assetId: string, input: { taxYearStart: string; taxYearEnd: string; amount: string; note?: string | null }) {
  requirePermission(ctx, "assets.manage");
  const amount = Decimal.tryFrom(input.amount?.replace(/[,\s$]/g, ""));
  const fields: Record<string, string> = {};
  if (!isIsoDate(input.taxYearStart)) fields.taxYearStart = "Enter the first day of the tax year.";
  if (!isIsoDate(input.taxYearEnd) || input.taxYearEnd < input.taxYearStart) fields.taxYearEnd = "Enter the last day of the tax year.";
  if (!amount || amount.isNegative()) fields.amount = "Enter the tax depreciation for the year.";
  if (Object.keys(fields).length) throw new ValidationError("Check the tax depreciation.", fields);
  await withTransaction(async (tx) => {
    const [asset] = await tx.select().from(fixedAssets).where(and(eq(fixedAssets.orgId, ctx.orgId), eq(fixedAssets.id, assetId)));
    if (!asset) throw new NotFoundError("The asset");
    await tx
      .insert(assetTaxDepreciation)
      .values({ orgId: ctx.orgId, assetId, taxYearStart: input.taxYearStart, taxYearEnd: input.taxYearEnd, amount: amount!.toString(), note: input.note?.trim() || null })
      .onConflictDoUpdate({
        target: [assetTaxDepreciation.orgId, assetTaxDepreciation.assetId, assetTaxDepreciation.taxYearStart],
        set: { taxYearEnd: input.taxYearEnd, amount: amount!.toString(), note: input.note?.trim() || null },
      });
    await audit(tx, ctx, { action: "asset.tax_depreciation_entered", entityType: "asset", entityId: assetId, metadata: { taxYearStart: input.taxYearStart, amount: amount!.toString() } });
  });
}

/** Tax depreciation for an asset in [from, to] from its tax book. */
export function taxDepreciationFor(
  book: AssetTaxBook,
  entered: { taxYearStart: string; taxYearEnd: string; amount: string }[],
  from: string,
  to: string,
  currency: string,
): Decimal {
  if (book.method === "entered") {
    return Decimal.sum(entered.filter((e) => e.taxYearStart >= from && e.taxYearEnd <= to).map((e) => e.amount));
  }
  const rows = computeSchedule({
    cost: book.taxBasis,
    residualValue: "0",
    usefulLifeMonths: book.usefulLifeMonths ?? 1,
    method: book.method,
    decliningFactor: book.decliningFactor,
    inServiceDate: book.placedInService,
    currency,
  });
  return sumBetween(rows, from, to);
}

/**
 * Book depreciation recognized in [from, to] for each asset: posted runs dated
 * in the window, less reversals dated in it (ledger dates, so it matches the
 * books for the year).
 */
export async function bookDepreciationBetween(db: DbOrTx, orgId: string, from: string, to: string): Promise<Map<string, Decimal>> {
  const res = await db.execute<{ asset_id: string; amount: string }>(sql`
    select l.asset_id, sum(l.amount)::text as amount
    from depreciation_run_lines l
    join depreciation_runs r on r.org_id = l.org_id and r.id = l.run_id
    join journal_entries e on e.org_id = r.org_id and e.id = r.journal_entry_id
    where l.org_id = ${orgId} and l.status in ('posted','reversed') and e.entry_date between ${from} and ${to}
    group by l.asset_id
    union all
    select l.asset_id, (-sum(l.amount))::text as amount
    from depreciation_run_lines l
    join depreciation_runs r on r.org_id = l.org_id and r.id = l.run_id
    join journal_entries e on e.org_id = r.org_id and e.id = r.reversal_entry_id
    where l.org_id = ${orgId} and l.status = 'reversed' and e.entry_date between ${from} and ${to}
    group by l.asset_id
  `);
  const out = new Map<string, Decimal>();
  for (const r of res.rows) out.set(r.asset_id, (out.get(r.asset_id) ?? Decimal.ZERO).add(r.amount));
  return out;
}

/**
 * Book versus tax depreciation for a tax year, per asset that has a tax
 * book. This is the interface the Gideon Tax export reads; it never posts.
 */
export async function taxDepreciationDifferences(
  db: DbOrTx,
  orgId: string,
  taxYearStart: string,
  taxYearEnd: string,
): Promise<{ assetId: string; assetName: string; bookDepreciation: string; taxDepreciation: string; difference: string }[]> {
  const [org] = await db.select({ baseCurrency: organizations.baseCurrency }).from(organizations).where(eq(organizations.id, orgId));
  const currency = org?.baseCurrency ?? "USD";
  const mu = minorUnits(currency);
  const books = await db
    .select({ book: assetTaxBooks, asset: fixedAssets })
    .from(assetTaxBooks)
    .innerJoin(fixedAssets, and(eq(fixedAssets.orgId, assetTaxBooks.orgId), eq(fixedAssets.id, assetTaxBooks.assetId)))
    .where(eq(assetTaxBooks.orgId, orgId))
    .orderBy(asc(fixedAssets.number));
  if (!books.length) return [];
  const entered = await db
    .select()
    .from(assetTaxDepreciation)
    .where(and(eq(assetTaxDepreciation.orgId, orgId), gte(assetTaxDepreciation.taxYearStart, taxYearStart), lte(assetTaxDepreciation.taxYearEnd, taxYearEnd)));
  const bookDep = await bookDepreciationBetween(db, orgId, taxYearStart, taxYearEnd);
  return books.map(({ book, asset }) => {
    const b = (bookDep.get(asset.id) ?? Decimal.ZERO).rescale(mu);
    const t = taxDepreciationFor(book, entered.filter((e) => e.assetId === asset.id), taxYearStart, taxYearEnd, currency).rescale(mu);
    return {
      assetId: asset.id,
      assetName: `${asset.number} ${asset.name}`,
      bookDepreciation: b.toString(),
      taxDepreciation: t.toString(),
      difference: t.sub(b).toString(),
    };
  });
}
