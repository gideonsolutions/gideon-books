/**
 * Sales-tax configuration: jurisdictions, dated rates, tax codes, and the
 * lookup of the components (and the rate in effect) for a code on a date.
 *
 * Gideon Books ships no rates. The organization enters the rates its taxing
 * authorities publish, with the dates they apply; a document uses the rate in
 * effect on its document date and keeps a copy of it. If no rate covers that
 * date the document is refused rather than taxed at whatever rate is current.
 */
import { and, asc, eq, gte, isNull, lte, or, inArray, sql } from "drizzle-orm";
import { withTransaction, type DbOrTx, type Tx } from "@/lib/db/client";
import { taxCodeComponents, taxCodes, taxJurisdictions, taxRates, accounts } from "@/lib/db/schema/ledger";
import { documentLineTaxes } from "@/lib/db/schema/commerce";
import { audit } from "@/lib/audit";
import { requirePermission, type Ctx } from "@/lib/context";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { Decimal } from "@/lib/money/decimal";
import { addDays, assertIsoDate, isIsoDate } from "@/lib/dates";
import { systemAccountId } from "@/lib/ledger/accounts";
import type { TaxComponent } from "./calculate";

export type TaxJurisdiction = typeof taxJurisdictions.$inferSelect;
export type TaxRate = typeof taxRates.$inferSelect;
export type TaxCode = typeof taxCodes.$inferSelect;

export class MissingTaxRateError extends ValidationError {
  constructor(code: string, jurisdiction: string, date: string) {
    super(
      `Tax code “${code}” has no ${jurisdiction} rate in effect on ${date}. Add the rate that applied on that date under Settings → Sales tax.`,
      { taxCodeId: "No rate in effect on the document date." },
      { code, jurisdiction, date },
    );
  }
}

export async function listJurisdictions(db: DbOrTx, orgId: string) {
  const js = await db.select().from(taxJurisdictions).where(eq(taxJurisdictions.orgId, orgId)).orderBy(asc(taxJurisdictions.name));
  const rates = await db.select().from(taxRates).where(eq(taxRates.orgId, orgId)).orderBy(asc(taxRates.effectiveFrom));
  return js.map((j) => ({ ...j, rates: rates.filter((r) => r.jurisdictionId === j.id) }));
}

export async function listTaxCodes(db: DbOrTx, orgId: string, opts: { includeArchived?: boolean } = {}) {
  const conds = [eq(taxCodes.orgId, orgId)];
  if (!opts.includeArchived) conds.push(eq(taxCodes.isArchived, false));
  const codes = await db.select().from(taxCodes).where(and(...conds)).orderBy(asc(taxCodes.name));
  const comps = await db.select().from(taxCodeComponents).where(eq(taxCodeComponents.orgId, orgId)).orderBy(asc(taxCodeComponents.sequence));
  return codes.map((c) => ({ ...c, components: comps.filter((x) => x.taxCodeId === c.id) }));
}

export async function createJurisdiction(
  ctx: Ctx,
  input: { name: string; code?: string | null; liabilityAccountId?: string | null; recoverableAccountId?: string | null; authorityContactId?: string | null; filingFrequency?: TaxJurisdiction["filingFrequency"] },
): Promise<TaxJurisdiction> {
  requirePermission(ctx, "sales_tax.manage");
  if (!input.name?.trim()) throw new ValidationError("Name the jurisdiction.", { name: "Required." });
  return withTransaction(async (tx) => {
    const liability = input.liabilityAccountId || (await systemAccountId(tx, ctx.orgId, "sales_tax_payable"));
    const [acc] = await tx.select().from(accounts).where(and(eq(accounts.orgId, ctx.orgId), eq(accounts.id, liability)));
    if (!acc || acc.type !== "liability") throw new ValidationError("Collected tax must be owed to a liability account.", { liabilityAccountId: "Pick a liability account." });
    const [row] = await tx
      .insert(taxJurisdictions)
      .values({
        orgId: ctx.orgId,
        name: input.name.trim(),
        code: input.code?.trim() || null,
        liabilityAccountId: liability,
        recoverableAccountId: input.recoverableAccountId || null,
        authorityContactId: input.authorityContactId || null,
        filingFrequency: input.filingFrequency ?? null,
      })
      .returning();
    await audit(tx, ctx, { action: "sales_tax.jurisdiction_created", entityType: "tax_jurisdiction", entityId: row!.id, after: row });
    return row!;
  });
}

export async function updateJurisdiction(
  ctx: Ctx,
  id: string,
  input: { name: string; code?: string | null; liabilityAccountId: string; recoverableAccountId?: string | null; authorityContactId?: string | null; filingFrequency?: TaxJurisdiction["filingFrequency"]; isArchived?: boolean },
) {
  requirePermission(ctx, "sales_tax.manage");
  return withTransaction(async (tx) => {
    const [before] = await tx.select().from(taxJurisdictions).where(and(eq(taxJurisdictions.orgId, ctx.orgId), eq(taxJurisdictions.id, id)));
    if (!before) throw new NotFoundError("The jurisdiction");
    const [row] = await tx
      .update(taxJurisdictions)
      .set({
        name: input.name.trim(),
        code: input.code?.trim() || null,
        liabilityAccountId: input.liabilityAccountId,
        recoverableAccountId: input.recoverableAccountId || null,
        authorityContactId: input.authorityContactId || null,
        filingFrequency: input.filingFrequency ?? null,
        isArchived: input.isArchived ?? before.isArchived,
      })
      .where(and(eq(taxJurisdictions.orgId, ctx.orgId), eq(taxJurisdictions.id, id)))
      .returning();
    await audit(tx, ctx, { action: "sales_tax.jurisdiction_updated", entityType: "tax_jurisdiction", entityId: id, before, after: row });
    return row!;
  });
}

/**
 * Add a dated rate. Rates for one jurisdiction may not overlap. If the
 * current open-ended rate starts before the new one, it is ended the day
 * before (a change of rate); a rate already used by a posted document is
 * never edited.
 */
export async function addTaxRate(
  ctx: Ctx,
  input: { jurisdictionId: string; name: string; rate: string; effectiveFrom: string; effectiveTo?: string | null; sourceNote?: string | null; ratePercent?: boolean },
): Promise<TaxRate> {
  requirePermission(ctx, "sales_tax.manage");
  const fields: Record<string, string> = {};
  if (!isIsoDate(input.effectiveFrom)) fields.effectiveFrom = "Enter the first day the rate applies.";
  if (input.effectiveTo && (!isIsoDate(input.effectiveTo) || input.effectiveTo < input.effectiveFrom)) fields.effectiveTo = "Must be on or after the start.";
  let rate = Decimal.tryFrom(input.rate?.replace("%", "").trim());
  if (!rate || rate.isNegative()) fields.rate = "Enter the rate, e.g. 4.75 for 4.75%.";
  if (Object.keys(fields).length) throw new ValidationError("Check the rate.", fields);
  if (input.ratePercent !== false) rate = rate!.div(100, 10, "half_up").normalize();
  if (!rate!.lt(1)) throw new ValidationError("A sales-tax rate must be under 100%.", { rate: "Too high." });
  return withTransaction(async (tx) => {
    const [j] = await tx.select().from(taxJurisdictions).where(and(eq(taxJurisdictions.orgId, ctx.orgId), eq(taxJurisdictions.id, input.jurisdictionId)));
    if (!j) throw new NotFoundError("The jurisdiction");
    const existing = await tx
      .select()
      .from(taxRates)
      .where(and(eq(taxRates.orgId, ctx.orgId), eq(taxRates.jurisdictionId, input.jurisdictionId)))
      .for("update");
    const newFrom = input.effectiveFrom;
    const newTo = input.effectiveTo ?? null;
    for (const r of existing) {
      const rTo = r.effectiveTo;
      const overlaps = (rTo === null || rTo >= newFrom) && (newTo === null || r.effectiveFrom <= newTo);
      if (!overlaps) continue;
      if (rTo === null && r.effectiveFrom < newFrom) {
        // The current rate ends the day before the new one starts.
        await tx.update(taxRates).set({ effectiveTo: addDays(newFrom, -1) }).where(eq(taxRates.id, r.id));
        await audit(tx, ctx, {
          action: "sales_tax.rate_ended",
          entityType: "tax_rate",
          entityId: r.id,
          before: { effectiveTo: null },
          after: { effectiveTo: addDays(newFrom, -1) },
        });
        continue;
      }
      throw new ConflictError(
        `That overlaps the ${r.name} rate (${r.effectiveFrom} to ${r.effectiveTo ?? "open-ended"}). Rates for one jurisdiction cannot overlap.`,
        "rate_overlap",
      );
    }
    const [row] = await tx
      .insert(taxRates)
      .values({
        orgId: ctx.orgId,
        jurisdictionId: input.jurisdictionId,
        name: input.name?.trim() || j.name,
        rate: rate!.toString(),
        effectiveFrom: newFrom,
        effectiveTo: newTo,
        sourceNote: input.sourceNote?.trim() || null,
      })
      .returning();
    await audit(tx, ctx, { action: "sales_tax.rate_added", entityType: "tax_rate", entityId: row!.id, after: row });
    return row!;
  });
}

export async function deleteTaxRate(ctx: Ctx, rateId: string) {
  requirePermission(ctx, "sales_tax.manage");
  await withTransaction(async (tx) => {
    const [r] = await tx.select().from(taxRates).where(and(eq(taxRates.orgId, ctx.orgId), eq(taxRates.id, rateId)));
    if (!r) throw new NotFoundError("The rate");
    const [used] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(documentLineTaxes)
      .where(and(eq(documentLineTaxes.orgId, ctx.orgId), eq(documentLineTaxes.taxRateId, rateId)));
    if ((used?.n ?? 0) > 0) throw new ConflictError("Documents were taxed at this rate; it stays as their record. Add a new rate from a later date instead.", "rate_in_use");
    await tx.delete(taxRates).where(eq(taxRates.id, rateId));
    await audit(tx, ctx, { action: "sales_tax.rate_deleted", entityType: "tax_rate", entityId: rateId, before: r });
  });
}

export async function saveTaxCode(
  ctx: Ctx,
  input: { id?: string | null; name: string; description?: string | null; isExempt?: boolean; components: { jurisdictionId: string; isCompound?: boolean }[]; isArchived?: boolean },
): Promise<TaxCode> {
  requirePermission(ctx, "sales_tax.manage");
  if (!input.name?.trim()) throw new ValidationError("Name the tax code.", { name: "Required." });
  if (!input.isExempt && input.components.length === 0) throw new ValidationError("A taxable code needs at least one jurisdiction.", { components: "Add a jurisdiction." });
  if (input.components[0]?.isCompound) throw new ValidationError("The first component cannot be compound.", { components: "Compound applies on top of earlier taxes." });
  return withTransaction(async (tx) => {
    let row: TaxCode;
    if (input.id) {
      const [before] = await tx.select().from(taxCodes).where(and(eq(taxCodes.orgId, ctx.orgId), eq(taxCodes.id, input.id)));
      if (!before) throw new NotFoundError("The tax code");
      [row] = (await tx
        .update(taxCodes)
        .set({ name: input.name.trim(), description: input.description ?? null, isExempt: input.isExempt ?? false, isArchived: input.isArchived ?? before.isArchived })
        .where(eq(taxCodes.id, input.id))
        .returning()) as [TaxCode];
      await tx.delete(taxCodeComponents).where(and(eq(taxCodeComponents.orgId, ctx.orgId), eq(taxCodeComponents.taxCodeId, input.id)));
    } else {
      [row] = (await tx
        .insert(taxCodes)
        .values({ orgId: ctx.orgId, name: input.name.trim(), description: input.description ?? null, isExempt: input.isExempt ?? false })
        .returning()) as [TaxCode];
    }
    if (!input.isExempt && input.components.length) {
      await tx.insert(taxCodeComponents).values(
        input.components.map((c, i) => ({ orgId: ctx.orgId, taxCodeId: row.id, jurisdictionId: c.jurisdictionId, sequence: i + 1, isCompound: c.isCompound ?? false })),
      );
    }
    await audit(tx, ctx, { action: input.id ? "sales_tax.code_updated" : "sales_tax.code_created", entityType: "tax_code", entityId: row.id, after: { ...row, components: input.components } });
    return row;
  });
}

/**
 * The components of a tax code with the rate in effect on `date`.
 * `side` picks the account: collected tax goes to the jurisdiction's
 * liability account; purchase tax is recoverable only if the jurisdiction
 * has a recoverable account, otherwise it is part of the cost.
 */
export async function loadTaxComponents(
  db: DbOrTx,
  orgId: string,
  taxCodeId: string,
  date: string,
  side: "sales" | "purchases",
): Promise<{ code: TaxCode; components: TaxComponent[] }> {
  assertIsoDate(date);
  const [code] = await db.select().from(taxCodes).where(and(eq(taxCodes.orgId, orgId), eq(taxCodes.id, taxCodeId)));
  if (!code) throw new NotFoundError("The tax code");
  if (code.isExempt) return { code, components: [] };
  const comps = await db
    .select({ comp: taxCodeComponents, jur: taxJurisdictions })
    .from(taxCodeComponents)
    .innerJoin(taxJurisdictions, and(eq(taxJurisdictions.id, taxCodeComponents.jurisdictionId), eq(taxJurisdictions.orgId, taxCodeComponents.orgId)))
    .where(and(eq(taxCodeComponents.orgId, orgId), eq(taxCodeComponents.taxCodeId, taxCodeId)))
    .orderBy(asc(taxCodeComponents.sequence));
  const jurIds = comps.map((c) => c.jur.id);
  const rates = jurIds.length
    ? await db
        .select()
        .from(taxRates)
        .where(
          and(
            eq(taxRates.orgId, orgId),
            inArray(taxRates.jurisdictionId, jurIds),
            lte(taxRates.effectiveFrom, date),
            or(isNull(taxRates.effectiveTo), gte(taxRates.effectiveTo, date)),
          ),
        )
    : [];
  const components: TaxComponent[] = comps.map(({ comp, jur }) => {
    const r = rates.find((x) => x.jurisdictionId === jur.id);
    if (!r) throw new MissingTaxRateError(code.name, jur.name, date);
    const recoverable = side === "purchases" && !!jur.recoverableAccountId;
    return {
      jurisdictionId: jur.id,
      jurisdictionName: jur.name,
      taxRateId: r.id,
      rate: Decimal.from(r.rate),
      sequence: comp.sequence,
      isCompound: comp.isCompound,
      accountId: side === "sales" ? jur.liabilityAccountId : recoverable ? jur.recoverableAccountId : null,
      isRecoverable: recoverable,
    };
  });
  return { code, components };
}

export async function loadTaxComponentsCached(db: DbOrTx | Tx, orgId: string, date: string, side: "sales" | "purchases") {
  const cache = new Map<string, Awaited<ReturnType<typeof loadTaxComponents>>>();
  return async (taxCodeId: string) => {
    let v = cache.get(taxCodeId);
    if (!v) {
      v = await loadTaxComponents(db, orgId, taxCodeId, date, side);
      cache.set(taxCodeId, v);
    }
    return v;
  };
}
