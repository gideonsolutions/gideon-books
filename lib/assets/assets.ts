/**
 * The fixed-asset register: creating assets, putting their cost on the books
 * (from a bill line, directly, or as an opening balance), changes of estimate,
 * and disposal. Depreciation runs are in depreciation.ts; the tax book in
 * tax-book.ts. See docs/accounting/fixed-assets.md.
 */
import { and, asc, desc, eq, ilike, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { withTransaction, type DbOrTx, type Tx } from "@/lib/db/client";
import { accounts, journalEntries, journalLines } from "@/lib/db/schema/ledger";
import { documentLines, documents } from "@/lib/db/schema/commerce";
import { assetDisposals, depreciationRunLines, fixedAssets, type DepreciationMethod } from "@/lib/db/schema/assets";
import { audit } from "@/lib/audit";
import { requirePermission, type Ctx } from "@/lib/context";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { Decimal } from "@/lib/money/decimal";
import { minorUnits } from "@/lib/money/currency";
import { addMonths, endOfMonth, isIsoDate, startOfMonth } from "@/lib/dates";
import { postEntry, reverseEntryInternal, type LineInput } from "@/lib/ledger/posting";
import { systemAccountId } from "@/lib/ledger/accounts";
import { nextNumber } from "@/lib/ledger/sequences";
import { computeSchedule, monthEnd, monthsThrough, type ScheduleRow } from "./schedule";

export type FixedAsset = typeof fixedAssets.$inferSelect;
export type AssetDisposal = typeof assetDisposals.$inferSelect;

export interface AssetInput {
  name: string;
  category?: string | null;
  description?: string | null;
  assetAccountId?: string | null;
  accumulatedDepreciationAccountId?: string | null;
  depreciationExpenseAccountId?: string | null;
  acquisitionDate: string;
  inServiceDate?: string | null;
  cost: string;
  residualValue?: string | null;
  usefulLifeMonths: number;
  method: DepreciationMethod;
  decliningFactor?: string | null;
  acquisitionType: FixedAsset["acquisitionType"];
  sourceDocumentLineId?: string | null;
  fundingAccountId?: string | null;
  openingAccumulatedDepreciation?: string | null;
  openingDepreciationThrough?: string | null;
  classId?: string | null;
  departmentId?: string | null;
  locationId?: string | null;
  projectId?: string | null;
  notes?: string | null;
}

function dec(v: string | null | undefined): Decimal | null {
  if (v === null || v === undefined || v.trim() === "") return null;
  return Decimal.tryFrom(v.replace(/[,\s$]/g, ""));
}

interface Normalized {
  cost: Decimal;
  residual: Decimal;
  factor: Decimal | null;
  opening: Decimal;
  inService: string;
}

function normalize(ctx: Ctx, input: AssetInput): Normalized {
  const fields: Record<string, string> = {};
  const mu = minorUnits(ctx.org.baseCurrency);
  if (!input.name?.trim()) fields.name = "Name the asset.";
  if (!isIsoDate(input.acquisitionDate)) fields.acquisitionDate = "Enter the acquisition date.";
  const inService = input.inServiceDate || input.acquisitionDate;
  if (!isIsoDate(inService)) fields.inServiceDate = "Enter the date it was placed in service.";
  else if (isIsoDate(input.acquisitionDate) && inService < input.acquisitionDate) fields.inServiceDate = "It cannot be in service before it was acquired.";
  const cost = dec(input.cost);
  if (!cost || cost.isNegative()) fields.cost = "Enter the cost.";
  else if (cost.decimalPlaces > mu) fields.cost = `Use at most ${mu} decimal places.`;
  const residual = dec(input.residualValue) ?? Decimal.ZERO;
  if (residual.isNegative()) fields.residualValue = "Cannot be negative.";
  else if (cost && residual.gt(cost)) fields.residualValue = "Cannot exceed the cost.";
  if (!Number.isInteger(input.usefulLifeMonths) || input.usefulLifeMonths < 1 || input.usefulLifeMonths > 1200) fields.usefulLifeMonths = "Enter a useful life of 1 to 1,200 months.";
  if (!["straight_line", "declining_balance", "none"].includes(input.method)) fields.method = "Choose a method.";
  let factor: Decimal | null = null;
  if (input.method === "declining_balance") {
    factor = dec(input.decliningFactor) ?? Decimal.from("2");
    if (!factor.isPositive() || factor.gt(4)) fields.decliningFactor = "Use a factor between 0 and 4 (2 = double declining).";
  }
  if (!["document_line", "direct", "opening"].includes(input.acquisitionType)) fields.acquisitionType = "Choose how it was acquired.";
  if (input.acquisitionType === "document_line" && !input.sourceDocumentLineId) fields.sourceDocumentLineId = "Choose the bill or expense line.";
  if (input.acquisitionType === "direct" && !input.fundingAccountId) fields.fundingAccountId = "Choose what paid for it (a bank account, card or loan).";
  const opening = dec(input.openingAccumulatedDepreciation) ?? Decimal.ZERO;
  if (input.acquisitionType === "opening") {
    if (!input.openingDepreciationThrough || !isIsoDate(input.openingDepreciationThrough)) fields.openingDepreciationThrough = "Enter the month-end the opening balance is as of.";
    else if (endOfMonth(input.openingDepreciationThrough) !== input.openingDepreciationThrough) fields.openingDepreciationThrough = "Use a month-end date.";
    if (opening.isNegative()) fields.openingAccumulatedDepreciation = "Cannot be negative.";
    else if (cost && opening.gt(cost.sub(residual))) fields.openingAccumulatedDepreciation = "Cannot exceed cost less residual value.";
  } else if (!opening.isZero()) {
    fields.openingAccumulatedDepreciation = "Only an opening asset carries prior depreciation.";
  }
  if (Object.keys(fields).length) throw new ValidationError("Check the asset.", fields);
  return { cost: cost!.rescale(mu), residual: residual.rescale(Math.max(mu, residual.scale)), factor, opening: opening.rescale(Math.max(mu, opening.scale)), inService };
}

async function checkAccounts(tx: DbOrTx, ctx: Ctx, ids: { asset: string; accumulated: string; expense: string; funding?: string | null }) {
  const rows = await tx
    .select()
    .from(accounts)
    .where(and(eq(accounts.orgId, ctx.orgId), inArray(accounts.id, [ids.asset, ids.accumulated, ids.expense, ...(ids.funding ? [ids.funding] : [])])));
  const by = new Map(rows.map((r) => [r.id, r]));
  const fields: Record<string, string> = {};
  const a = by.get(ids.asset);
  if (!a || a.subtype !== "fixed_asset") fields.assetAccountId = "Choose a fixed-asset account.";
  const acc = by.get(ids.accumulated);
  if (!acc || acc.subtype !== "accumulated_depreciation") fields.accumulatedDepreciationAccountId = "Choose an accumulated depreciation account.";
  const e = by.get(ids.expense);
  if (!e || e.type !== "expense") fields.depreciationExpenseAccountId = "Choose an expense account.";
  if (ids.funding) {
    const f = by.get(ids.funding);
    if (!f || f.control || !["asset", "liability", "equity"].includes(f.type) || f.subtype === "fixed_asset") {
      fields.fundingAccountId = "Choose a bank, card, cash, loan or equity account (not a subledger account).";
    }
  }
  for (const r of rows) if (r.isArchived) fields[r.id === ids.asset ? "assetAccountId" : r.id === ids.accumulated ? "accumulatedDepreciationAccountId" : "depreciationExpenseAccountId"] = `${r.name} is archived.`;
  if (Object.keys(fields).length) throw new ValidationError("Check the asset's accounts.", fields);
}

export async function getAsset(db: DbOrTx, orgId: string, id: string): Promise<FixedAsset> {
  const [a] = await db.select().from(fixedAssets).where(and(eq(fixedAssets.orgId, orgId), eq(fixedAssets.id, id)));
  if (!a) throw new NotFoundError("The asset");
  return a;
}

/** Depreciation posted for an asset (excluding reversed runs), and the months held by drafts. */
export async function depreciationState(db: DbOrTx, orgId: string, asset: FixedAsset) {
  const lines = await db
    .select()
    .from(depreciationRunLines)
    .where(and(eq(depreciationRunLines.orgId, orgId), eq(depreciationRunLines.assetId, asset.id), ne(depreciationRunLines.status, "reversed")))
    .orderBy(asc(depreciationRunLines.periodEnd));
  const posted = lines.filter((l) => l.status === "posted");
  const postedTotal = Decimal.sum(posted.map((l) => l.amount));
  const opening = Decimal.from(asset.openingAccumulatedDepreciation);
  const openingMonths = asset.acquisitionType === "opening" && asset.openingDepreciationThrough ? monthsThrough(asset.inServiceDate, asset.openingDepreciationThrough) : 0;
  const heldMonths = lines.length ? Math.max(...lines.map((l) => monthsThrough(asset.inServiceDate, l.periodEnd))) : 0;
  const postedMonths = posted.length ? Math.max(...posted.map((l) => monthsThrough(asset.inServiceDate, l.periodEnd))) : 0;
  const draftTotal = Decimal.sum(lines.filter((l) => l.status === "draft").map((l) => l.amount));
  return {
    lines,
    postedAccumulated: opening.add(postedTotal),
    /** Including drafts: where the next run starts. */
    heldAccumulated: opening.add(postedTotal).add(draftTotal),
    monthsUsed: Math.max(openingMonths, heldMonths),
    postedMonthsUsed: Math.max(openingMonths, postedMonths),
  };
}

export function scheduleInput(asset: FixedAsset, currency: string) {
  return {
    cost: asset.cost,
    residualValue: asset.residualValue,
    usefulLifeMonths: asset.usefulLifeMonths,
    method: asset.method,
    decliningFactor: asset.decliningFactor,
    inServiceDate: asset.inServiceDate,
    currency,
  };
}

/** The asset's full schedule: depreciation taken (posted) followed by the projection. */
export async function assetSchedule(db: DbOrTx, orgId: string, asset: FixedAsset, currency: string) {
  const state = await depreciationState(db, orgId, asset);
  const projected = asset.status === "disposed" ? [] : computeSchedule(scheduleInput(asset, currency), { accumulated: state.postedAccumulated, monthsUsed: state.postedMonthsUsed });
  let acc = Decimal.from(asset.openingAccumulatedDepreciation);
  const taken: (ScheduleRow & { status: "posted" | "draft" })[] = state.lines.map((l) => {
    acc = acc.add(l.status === "posted" ? l.amount : "0");
    return {
      index: monthsThrough(asset.inServiceDate, l.periodEnd) - 1,
      periodEnd: l.periodEnd,
      amount: Decimal.from(l.amount),
      accumulated: acc,
      netBookValue: Decimal.from(asset.cost).sub(acc),
      status: l.status as "posted" | "draft",
    };
  });
  const draftMonths = new Set(taken.filter((t) => t.status === "draft").map((t) => t.periodEnd));
  return {
    state,
    taken: taken.filter((t) => t.status === "posted"),
    projected: asset.status === "disposed" ? [] : projected.map((p) => ({ ...p, inDraft: draftMonths.has(p.periodEnd) })),
  };
}

export interface AssetFilters {
  q?: string;
  status?: FixedAsset["status"];
  category?: string;
  page?: number;
  pageSize?: number;
}

export async function listAssets(db: DbOrTx, orgId: string, f: AssetFilters = {}) {
  const conds: SQL[] = [eq(fixedAssets.orgId, orgId)];
  if (f.status) conds.push(eq(fixedAssets.status, f.status));
  if (f.category) conds.push(eq(fixedAssets.category, f.category));
  if (f.q) {
    const like = `%${f.q.replace(/[%_]/g, "\\$&")}%`;
    conds.push(or(ilike(fixedAssets.name, like), ilike(fixedAssets.number, like), ilike(fixedAssets.category, like))!);
  }
  const pageSize = Math.min(Math.max(f.pageSize ?? 50, 1), 500);
  const page = Math.max(f.page ?? 1, 1);
  const where = and(...conds);
  const accumulatedExpr = sql<string>`(${fixedAssets.openingAccumulatedDepreciation} + coalesce((select sum(l.amount) from depreciation_run_lines l where l.org_id = ${fixedAssets.orgId} and l.asset_id = ${fixedAssets.id} and l.status = 'posted'), 0))::text`;
  const [rows, [count], totals] = await Promise.all([
    db
      .select({ asset: fixedAssets, accumulated: accumulatedExpr })
      .from(fixedAssets)
      .where(where)
      .orderBy(desc(fixedAssets.acquisitionDate), asc(fixedAssets.number))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(fixedAssets).where(where),
    db
      .select({ cost: sql<string>`coalesce(sum(${fixedAssets.cost}) filter (where ${fixedAssets.status} <> 'disposed' and ${fixedAssets.status} <> 'draft'), 0)::text`, accumulated: sql<string>`coalesce(sum(${accumulatedExpr}::numeric) filter (where ${fixedAssets.status} <> 'disposed' and ${fixedAssets.status} <> 'draft'), 0)::text` })
      .from(fixedAssets)
      .where(where),
  ]);
  return { rows, total: count?.n ?? 0, page, pageSize, totals: totals[0]! };
}

export async function assetCategories(db: DbOrTx, orgId: string): Promise<string[]> {
  const rows = await db.selectDistinct({ c: fixedAssets.category }).from(fixedAssets).where(and(eq(fixedAssets.orgId, orgId), sql`${fixedAssets.category} is not null`));
  return rows.map((r) => r.c!).sort();
}

/**
 * Posted bill and expense lines that debited a fixed-asset account and are
 * not yet in the register: what can be capitalized from a document.
 */
export async function capitalizableLines(db: DbOrTx, orgId: string) {
  const rows = await db
    .select({ line: documentLines, doc: documents, account: accounts, base: journalLines.baseAmount })
    .from(documentLines)
    .innerJoin(documents, and(eq(documents.orgId, documentLines.orgId), eq(documents.id, documentLines.documentId)))
    .innerJoin(accounts, and(eq(accounts.orgId, documentLines.orgId), eq(accounts.id, documentLines.accountId)))
    .innerJoin(
      journalLines,
      and(eq(journalLines.orgId, documentLines.orgId), eq(journalLines.entryId, documents.journalEntryId), eq(journalLines.sourceLineId, documentLines.id)),
    )
    .leftJoin(fixedAssets, and(eq(fixedAssets.orgId, documentLines.orgId), eq(fixedAssets.sourceDocumentLineId, documentLines.id), ne(fixedAssets.status, "draft")))
    .where(
      and(
        eq(documentLines.orgId, orgId),
        eq(accounts.subtype, "fixed_asset"),
        inArray(documents.kind, ["bill", "expense"]),
        inArray(documents.status, ["issued", "partially_paid", "paid"]),
        isNull(fixedAssets.id),
      ),
    )
    .orderBy(desc(documents.issueDate));
  return rows.map((r) => ({
    lineId: r.line.id,
    documentId: r.doc.id,
    documentKind: r.doc.kind,
    documentNumber: r.doc.number ?? r.doc.reference,
    date: r.doc.postingDate ?? r.doc.issueDate,
    description: r.line.description,
    accountId: r.account.id,
    accountName: `${r.account.code} ${r.account.name}`,
    /** The base-currency amount the line debited to the asset account. */
    amount: Decimal.from(r.base).toString(),
  }));
}

function values(input: AssetInput, n: Normalized, ids: { asset: string; accumulated: string; expense: string }) {
  return {
    name: input.name.trim(),
    category: input.category?.trim() || null,
    description: input.description?.trim() || null,
    assetAccountId: ids.asset,
    accumulatedDepreciationAccountId: ids.accumulated,
    depreciationExpenseAccountId: ids.expense,
    acquisitionDate: input.acquisitionDate,
    inServiceDate: n.inService,
    cost: n.cost.toString(),
    residualValue: n.residual.toString(),
    usefulLifeMonths: input.usefulLifeMonths,
    method: input.method,
    decliningFactor: n.factor?.toString() ?? null,
    acquisitionType: input.acquisitionType,
    sourceDocumentLineId: input.acquisitionType === "document_line" ? (input.sourceDocumentLineId ?? null) : null,
    fundingAccountId: input.acquisitionType === "direct" ? (input.fundingAccountId ?? null) : null,
    openingAccumulatedDepreciation: n.opening.toString(),
    openingDepreciationThrough: input.acquisitionType === "opening" ? (input.openingDepreciationThrough ?? null) : null,
    classId: input.classId || null,
    departmentId: input.departmentId || null,
    locationId: input.locationId || null,
    projectId: input.projectId || null,
    notes: input.notes?.trim() || null,
  };
}

async function resolveAccounts(tx: Tx, ctx: Ctx, input: AssetInput) {
  return {
    asset: input.assetAccountId || (await systemAccountId(tx, ctx.orgId, "fixed_assets")),
    accumulated: input.accumulatedDepreciationAccountId || (await systemAccountId(tx, ctx.orgId, "accumulated_depreciation")),
    expense: input.depreciationExpenseAccountId || (await systemAccountId(tx, ctx.orgId, "depreciation_expense")),
  };
}

/** Save a new asset as a draft (nothing posted until it is capitalized). */
export async function createAsset(ctx: Ctx, input: AssetInput): Promise<FixedAsset> {
  requirePermission(ctx, "assets.manage");
  const n = normalize(ctx, input);
  return withTransaction(async (tx) => {
    const ids = await resolveAccounts(tx, ctx, input);
    await checkAccounts(tx, ctx, { ...ids, funding: input.acquisitionType === "direct" ? input.fundingAccountId : null });
    const number = (await nextNumber(tx, ctx.orgId, "asset")).formatted;
    const [row] = await tx
      .insert(fixedAssets)
      .values({ orgId: ctx.orgId, number, status: "draft", createdBy: ctx.actor.userId, ...values(input, n, ids) })
      .returning();
    await audit(tx, ctx, { action: "asset.created", entityType: "asset", entityId: row!.id, after: row });
    return row!;
  });
}

/**
 * Edit an asset. A draft can change anything. A capitalized asset keeps its
 * cost, accounts and acquisition; its estimates (life, residual value,
 * method) change prospectively — depreciation already posted stays.
 */
export async function updateAsset(ctx: Ctx, id: string, input: AssetInput): Promise<FixedAsset> {
  requirePermission(ctx, "assets.manage");
  const n = normalize(ctx, input);
  return withTransaction(async (tx) => {
    const [before] = await tx.select().from(fixedAssets).where(and(eq(fixedAssets.orgId, ctx.orgId), eq(fixedAssets.id, id))).for("update");
    if (!before) throw new NotFoundError("The asset");
    if (before.status === "disposed") throw new ConflictError("A disposed asset cannot be edited. Reverse the disposal first.", "asset_disposed");
    const ids = await resolveAccounts(tx, ctx, input);
    await checkAccounts(tx, ctx, { ...ids, funding: input.acquisitionType === "direct" ? input.fundingAccountId : null });
    let set: Partial<typeof fixedAssets.$inferInsert>;
    if (before.status === "draft") {
      set = values(input, n, ids);
    } else {
      const fixed: string[] = [];
      if (!n.cost.eq(before.cost)) fixed.push("cost");
      if (ids.asset !== before.assetAccountId) fixed.push("asset account");
      if (ids.accumulated !== before.accumulatedDepreciationAccountId) fixed.push("accumulated depreciation account");
      if (input.acquisitionType !== before.acquisitionType) fixed.push("acquisition");
      if (n.inService !== before.inServiceDate) fixed.push("in-service date");
      if (fixed.length) {
        throw new ConflictError(
          `The ${fixed.join(", ")} of a capitalized asset cannot change — the books already carry them. Dispose of it and capitalize a corrected asset, or adjust with a journal entry to a non-control account.`,
          "asset_capitalized",
        );
      }
      const state = await depreciationState(tx, ctx.orgId, before);
      if (n.residual.gt(n.cost.sub(state.postedAccumulated)) && !n.residual.eq(before.residualValue)) {
        throw new ValidationError("The residual value would be below what has already been depreciated.", { residualValue: "Too high." });
      }
      if (input.usefulLifeMonths < state.postedMonthsUsed) {
        throw new ValidationError(`Depreciation is already posted for ${state.postedMonthsUsed} months; the life cannot be shorter.`, { usefulLifeMonths: "Too short." });
      }
      set = {
        name: input.name.trim(),
        category: input.category?.trim() || null,
        description: input.description?.trim() || null,
        depreciationExpenseAccountId: ids.expense,
        residualValue: n.residual.toString(),
        usefulLifeMonths: input.usefulLifeMonths,
        method: input.method,
        decliningFactor: n.factor?.toString() ?? null,
        classId: input.classId || null,
        departmentId: input.departmentId || null,
        locationId: input.locationId || null,
        projectId: input.projectId || null,
        notes: input.notes?.trim() || null,
      };
    }
    const [row] = await tx
      .update(fixedAssets)
      .set({ ...set, updatedAt: new Date() })
      .where(eq(fixedAssets.id, id))
      .returning();
    const after = await refreshStatus(tx, ctx, row!);
    await audit(tx, ctx, { action: before.status === "draft" ? "asset.updated" : "asset.estimate_changed", entityType: "asset", entityId: id, before, after });
    return after;
  });
}

/** Mark an active asset fully depreciated (or active again) from its posted depreciation. */
export async function refreshStatus(tx: Tx, ctx: Ctx, asset: FixedAsset): Promise<FixedAsset> {
  if (asset.status !== "active" && asset.status !== "fully_depreciated") return asset;
  const state = await depreciationState(tx, ctx.orgId, asset);
  const base = Decimal.from(asset.cost).sub(asset.residualValue);
  const full = asset.method !== "none" && state.postedAccumulated.gte(base);
  const status = full ? "fully_depreciated" : "active";
  if (status === asset.status) return asset;
  const [row] = await tx.update(fixedAssets).set({ status, updatedAt: new Date() }).where(eq(fixedAssets.id, asset.id)).returning();
  return row!;
}

export async function deleteDraftAsset(ctx: Ctx, id: string): Promise<void> {
  requirePermission(ctx, "assets.manage");
  await withTransaction(async (tx) => {
    const [a] = await tx.select().from(fixedAssets).where(and(eq(fixedAssets.orgId, ctx.orgId), eq(fixedAssets.id, id))).for("update");
    if (!a) throw new NotFoundError("The asset");
    if (a.status !== "draft") throw new ConflictError("Only a draft asset can be deleted; a capitalized asset is disposed of.", "not_draft");
    await tx.delete(fixedAssets).where(eq(fixedAssets.id, id));
    await audit(tx, ctx, { action: "asset.deleted", entityType: "asset", entityId: id, before: a });
  });
}

/**
 * Put a draft asset's cost on the books and make it active:
 *  - from a document line: the bill or expense already debited the asset
 *    account; the asset is linked to that line (its cost must equal the line);
 *  - direct: Dr asset, Cr the funding account, on the acquisition date;
 *  - opening: Dr asset at cost, Cr accumulated depreciation for what was taken
 *    before the books started, Cr opening balance equity for the net.
 */
export async function capitalizeAsset(ctx: Ctx, id: string): Promise<FixedAsset> {
  requirePermission(ctx, "assets.manage");
  return withTransaction(async (tx) => {
    const [a] = await tx.select().from(fixedAssets).where(and(eq(fixedAssets.orgId, ctx.orgId), eq(fixedAssets.id, id))).for("update");
    if (!a) throw new NotFoundError("The asset");
    if (a.status !== "draft") throw new ConflictError("This asset is already on the books.", "already_capitalized");
    const cost = Decimal.from(a.cost);
    const dims = { classId: a.classId, departmentId: a.departmentId, locationId: a.locationId, projectId: a.projectId };
    let capitalizedOn = a.acquisitionDate;
    let entryId: string | null = null;
    let sourceDocumentId: string | null = null;

    if (a.acquisitionType === "document_line") {
      const [row] = await tx
        .select({ line: documentLines, doc: documents, base: journalLines.baseAmount, jlAccount: journalLines.accountId })
        .from(documentLines)
        .innerJoin(documents, and(eq(documents.orgId, documentLines.orgId), eq(documents.id, documentLines.documentId)))
        .innerJoin(journalLines, and(eq(journalLines.orgId, documentLines.orgId), eq(journalLines.entryId, documents.journalEntryId), eq(journalLines.sourceLineId, documentLines.id)))
        .where(and(eq(documentLines.orgId, ctx.orgId), eq(documentLines.id, a.sourceDocumentLineId!)));
      if (!row) throw new ValidationError("That document line is not posted.", { sourceDocumentLineId: "Choose a posted bill or expense line." });
      if (!["bill", "expense"].includes(row.doc.kind) || !["issued", "partially_paid", "paid"].includes(row.doc.status)) {
        throw new ValidationError("Capitalize from a posted bill or expense.", { sourceDocumentLineId: "Not a posted purchase." });
      }
      if (row.jlAccount !== a.assetAccountId) {
        throw new ValidationError("That line was posted to a different account than the asset's account. Choose the asset account the bill used.", { assetAccountId: "Must match the bill line's account." });
      }
      if (!Decimal.from(row.base).eq(cost)) {
        throw new ValidationError(`The asset's cost (${cost.toString()}) must equal what the line put on the books (${Decimal.from(row.base).toString()}).`, { cost: "Must equal the source line." });
      }
      const [clash] = await tx
        .select({ id: fixedAssets.id, number: fixedAssets.number })
        .from(fixedAssets)
        .where(and(eq(fixedAssets.orgId, ctx.orgId), eq(fixedAssets.sourceDocumentLineId, a.sourceDocumentLineId!), ne(fixedAssets.id, id), ne(fixedAssets.status, "draft")));
      if (clash) throw new ConflictError(`That line is already capitalized as ${clash.number}.`, "line_capitalized");
      capitalizedOn = row.doc.postingDate ?? row.doc.issueDate;
      sourceDocumentId = row.doc.id;
    } else if (a.acquisitionType === "direct") {
      const posted = await postEntry(tx, ctx, {
        kind: "asset",
        entryDate: a.acquisitionDate,
        description: `Acquisition of ${a.number} ${a.name}`,
        sourceType: "asset",
        sourceId: a.id,
        sourceRef: a.number,
        idempotencyKey: `asset:${a.id}:acquire`,
        allowControlAccounts: true,
        lines: [
          { accountId: a.assetAccountId, amount: cost.toString(), description: a.name, ...dims },
          { accountId: a.fundingAccountId!, amount: cost.neg().toString(), description: `${a.number} ${a.name}` },
        ],
      });
      entryId = posted.entry.id;
    } else {
      const opening = Decimal.from(a.openingAccumulatedDepreciation);
      const obe = await systemAccountId(tx, ctx.orgId, "opening_balance_equity");
      const lines: LineInput[] = [{ accountId: a.assetAccountId, amount: cost.toString(), description: `${a.name} (opening cost)`, ...dims }];
      if (!opening.isZero()) lines.push({ accountId: a.accumulatedDepreciationAccountId, amount: opening.neg().toString(), description: `${a.name} (opening accumulated depreciation)` });
      const net = cost.sub(opening);
      if (!net.isZero()) lines.push({ accountId: obe, amount: net.neg().toString(), description: `${a.number} opening balance` });
      capitalizedOn = a.openingDepreciationThrough!;
      if (lines.length > 1) {
        const posted = await postEntry(tx, ctx, {
          kind: "opening_balance",
          entryDate: capitalizedOn,
          description: `Opening balance of ${a.number} ${a.name}`,
          sourceType: "asset",
          sourceId: a.id,
          sourceRef: a.number,
          idempotencyKey: `asset:${a.id}:opening`,
          allowControlAccounts: true,
          lines,
        });
        entryId = posted.entry.id;
      }
    }
    const [row] = await tx
      .update(fixedAssets)
      .set({ status: "active", capitalizedOn, acquisitionEntryId: entryId, sourceDocumentId, updatedAt: new Date() })
      .where(eq(fixedAssets.id, id))
      .returning();
    const after = await refreshStatus(tx, ctx, row!);
    await audit(tx, ctx, { action: "asset.capitalized", entityType: "asset", entityId: id, metadata: { acquisitionType: a.acquisitionType, cost: a.cost, capitalizedOn, entryId } });
    return after;
  });
}

/**
 * Dispose of (sell or write off) an asset on `date`. Depreciation is taken
 * through the month before the disposal month and none in it; disposal is
 * refused until those months are posted. The entry removes the cost and the
 * accumulated depreciation, records any proceeds, and books the difference
 * to gain or loss on disposal.
 */
export async function disposeAsset(
  ctx: Ctx,
  id: string,
  input: { date: string; proceeds?: string | null; proceedsAccountId?: string | null; reason: string },
): Promise<AssetDisposal> {
  requirePermission(ctx, "assets.manage");
  if (!isIsoDate(input.date)) throw new ValidationError("Enter the disposal date.", { date: "Required." });
  if (!input.reason?.trim()) throw new ValidationError("Say how the asset was disposed of (sold, scrapped, lost…).", { reason: "Required." });
  const proceeds = dec(input.proceeds) ?? Decimal.ZERO;
  if (proceeds.isNegative()) throw new ValidationError("Proceeds cannot be negative.", { proceeds: "Must not be negative." });
  if (!proceeds.isZero() && !input.proceedsAccountId) throw new ValidationError("Choose where the proceeds went.", { proceedsAccountId: "Required with proceeds." });
  return withTransaction(async (tx) => {
    const [a] = await tx.select().from(fixedAssets).where(and(eq(fixedAssets.orgId, ctx.orgId), eq(fixedAssets.id, id))).for("update");
    if (!a) throw new NotFoundError("The asset");
    if (a.status === "draft") throw new ConflictError("A draft asset is not on the books; delete it instead.", "not_capitalized");
    if (a.status === "disposed") throw new ConflictError("This asset was already disposed of.", "already_disposed");
    if (a.capitalizedOn && input.date < a.capitalizedOn) throw new ValidationError("It cannot be disposed of before it was on the books.", { date: `On or after ${a.capitalizedOn}.` });
    if (input.proceedsAccountId) {
      const [acc] = await tx.select().from(accounts).where(and(eq(accounts.orgId, ctx.orgId), eq(accounts.id, input.proceedsAccountId)));
      if (!acc || acc.control || acc.type !== "asset") {
        throw new ValidationError("Proceeds go to a bank, cash or other asset account (not a subledger account). To invoice the buyer, record the sale on an invoice to a clearing account and use that.", { proceedsAccountId: "Not allowed." });
      }
    }
    // Depreciation must be posted through the month before the disposal month.
    const state = await depreciationState(tx, ctx.orgId, a);
    const priorMonthEnd = endOfMonth(addMonths(startOfMonth(input.date), -1));
    const due = computeSchedule(scheduleInput(a, ctx.org.baseCurrency), { accumulated: state.postedAccumulated, monthsUsed: state.postedMonthsUsed }).filter((r) => r.periodEnd <= priorMonthEnd);
    if (due.length) {
      throw new ConflictError(
        `Post depreciation through ${priorMonthEnd} first (${due.length} month${due.length === 1 ? "" : "s"} outstanding, from ${due[0]!.periodEnd}). Depreciation runs are under Fixed assets → Depreciation runs.`,
        "depreciation_outstanding",
        { months: due.map((d) => d.periodEnd) },
      );
    }
    // Draft runs no longer apply to a disposed asset.
    await tx
      .delete(depreciationRunLines)
      .where(and(eq(depreciationRunLines.orgId, ctx.orgId), eq(depreciationRunLines.assetId, id), eq(depreciationRunLines.status, "draft")));
    const cost = Decimal.from(a.cost);
    const accumulated = state.postedAccumulated;
    const nbv = cost.sub(accumulated);
    const gain = proceeds.sub(nbv);
    const gainAccount = await systemAccountId(tx, ctx.orgId, "asset_disposal_gain_loss");
    const dims = { classId: a.classId, departmentId: a.departmentId, locationId: a.locationId, projectId: a.projectId };
    const lines: LineInput[] = [{ accountId: a.assetAccountId, amount: cost.neg().toString(), description: `${a.number} ${a.name} disposed`, ...dims }];
    if (!accumulated.isZero()) lines.push({ accountId: a.accumulatedDepreciationAccountId, amount: accumulated.toString(), description: `${a.number} accumulated depreciation removed` });
    if (!proceeds.isZero()) lines.push({ accountId: input.proceedsAccountId!, amount: proceeds.toString(), description: `Proceeds from ${a.number} ${a.name}` });
    if (!gain.isZero()) lines.push({ accountId: gainAccount, amount: gain.neg().toString(), description: gain.isPositive() ? `Gain on disposal of ${a.number}` : `Loss on disposal of ${a.number}`, ...dims });
    const [disposal] = await tx
      .insert(assetDisposals)
      .values({
        orgId: ctx.orgId,
        assetId: id,
        disposalDate: input.date,
        proceeds: proceeds.toString(),
        proceedsAccountId: input.proceedsAccountId || null,
        costRemoved: cost.toString(),
        accumulatedRemoved: accumulated.toString(),
        gainLoss: gain.toString(),
        reason: input.reason.trim(),
        createdBy: ctx.actor.userId,
      })
      .returning();
    let entryId: string | null = null;
    if (lines.length >= 2) {
      const posted = await postEntry(tx, ctx, {
        kind: "asset",
        entryDate: input.date,
        description: `Disposal of ${a.number} ${a.name}: ${input.reason.trim()}`,
        sourceType: "asset_disposal",
        sourceId: a.id,
        sourceRef: a.number,
        idempotencyKey: `asset-disposal:${disposal!.id}`,
        allowControlAccounts: true,
        lines,
      });
      entryId = posted.entry.id;
      await tx.update(assetDisposals).set({ journalEntryId: entryId }).where(eq(assetDisposals.id, disposal!.id));
    }
    await tx.update(fixedAssets).set({ status: "disposed", disposedOn: input.date, updatedAt: new Date() }).where(eq(fixedAssets.id, id));
    await audit(tx, ctx, {
      action: "asset.disposed",
      entityType: "asset",
      entityId: id,
      reason: input.reason.trim(),
      metadata: { date: input.date, proceeds: proceeds.toString(), gainLoss: gain.toString(), entryId },
    });
    return { ...disposal!, journalEntryId: entryId };
  });
}

/** Undo a disposal (its entry is reversed on `date`); the asset is active again. */
export async function reverseDisposal(ctx: Ctx, assetId: string, input: { date: string; reason: string }): Promise<void> {
  requirePermission(ctx, "assets.manage");
  if (!input.reason?.trim()) throw new ValidationError("Say why the disposal is being undone.", { reason: "Required." });
  if (!isIsoDate(input.date)) throw new ValidationError("Enter the date of the reversal.", { date: "Required." });
  await withTransaction(async (tx) => {
    const [a] = await tx.select().from(fixedAssets).where(and(eq(fixedAssets.orgId, ctx.orgId), eq(fixedAssets.id, assetId))).for("update");
    if (!a) throw new NotFoundError("The asset");
    const [d] = await tx
      .select()
      .from(assetDisposals)
      .where(and(eq(assetDisposals.orgId, ctx.orgId), eq(assetDisposals.assetId, assetId), eq(assetDisposals.status, "posted")))
      .for("update");
    if (!d) throw new ConflictError("This asset has no disposal to undo.", "not_disposed");
    let revId: string | null = null;
    if (d.journalEntryId) {
      const date = input.date < d.disposalDate ? d.disposalDate : input.date;
      const rev = await reverseEntryInternal(tx, ctx, d.journalEntryId, { date, reason: input.reason.trim() });
      revId = rev.entry.id;
    }
    await tx.update(assetDisposals).set({ status: "reversed", reversalEntryId: revId, reversalReason: input.reason.trim() }).where(eq(assetDisposals.id, d.id));
    const [row] = await tx.update(fixedAssets).set({ status: "active", disposedOn: null, updatedAt: new Date() }).where(eq(fixedAssets.id, assetId)).returning();
    await refreshStatus(tx, ctx, row!);
    await audit(tx, ctx, { action: "asset.disposal_reversed", entityType: "asset", entityId: assetId, reason: input.reason.trim() });
  });
}

export async function assetDisposalsFor(db: DbOrTx, orgId: string, assetId: string): Promise<AssetDisposal[]> {
  return db.select().from(assetDisposals).where(and(eq(assetDisposals.orgId, orgId), eq(assetDisposals.assetId, assetId))).orderBy(desc(assetDisposals.createdAt));
}

/** The journal entries an asset produced (acquisition, depreciation runs, disposals). */
export async function assetEntries(db: DbOrTx, orgId: string, asset: FixedAsset) {
  const ids = new Set<string>();
  if (asset.acquisitionEntryId) ids.add(asset.acquisitionEntryId);
  const runs = await db.execute<{ journal_entry_id: string | null; reversal_entry_id: string | null }>(sql`
    select distinct r.journal_entry_id, r.reversal_entry_id from depreciation_runs r
    join depreciation_run_lines l on l.org_id = r.org_id and l.run_id = r.id
    where r.org_id = ${orgId} and l.asset_id = ${asset.id}
  `);
  for (const r of runs.rows) {
    if (r.journal_entry_id) ids.add(r.journal_entry_id);
    if (r.reversal_entry_id) ids.add(r.reversal_entry_id);
  }
  for (const d of await assetDisposalsFor(db, orgId, asset.id)) {
    if (d.journalEntryId) ids.add(d.journalEntryId);
    if (d.reversalEntryId) ids.add(d.reversalEntryId);
  }
  if (!ids.size) return [];
  return db.select().from(journalEntries).where(and(eq(journalEntries.orgId, orgId), inArray(journalEntries.id, [...ids]))).orderBy(asc(journalEntries.entryDate), asc(journalEntries.entryNumber));
}

export { monthEnd };
