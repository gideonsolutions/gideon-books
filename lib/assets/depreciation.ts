/**
 * Depreciation runs: prepare (a draft listing each asset-month due through a
 * month-end), review, post (one entry), and reverse. Each asset-month is held
 * by at most one draft or posted run line (a unique index), so a period can
 * never be depreciated twice — re-preparing finds nothing due, re-posting a
 * posted run does nothing, and two people posting at once post once.
 */
import { and, asc, desc, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { getDb, pgErrorCode, withTransaction, type DbOrTx } from "@/lib/db/client";
import { assetSettings, depreciationRunLines, depreciationRuns, fixedAssets } from "@/lib/db/schema/assets";
import { audit } from "@/lib/audit";
import { requirePermission, systemCtx, type Ctx } from "@/lib/context";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { Decimal } from "@/lib/money/decimal";
import { endOfMonth, isIsoDate, todayIn, addMonths, startOfMonth } from "@/lib/dates";
import { postEntry, reverseEntryInternal, type LineInput } from "@/lib/ledger/posting";
import { isDateOpen } from "@/lib/ledger/periods";
import { computeSchedule } from "./schedule";
import { depreciationState, refreshStatus, scheduleInput, type FixedAsset } from "./assets";

export type DepreciationRun = typeof depreciationRuns.$inferSelect;
export type DepreciationRunLine = typeof depreciationRunLines.$inferSelect;

export interface DueLine {
  assetId: string;
  assetNumber: string;
  assetName: string;
  periodEnd: string;
  amount: Decimal;
}

function assertMonthEnd(periodEnd: string) {
  if (!isIsoDate(periodEnd) || endOfMonth(periodEnd) !== periodEnd) {
    throw new ValidationError("Depreciation runs are for a month-end date.", { periodEnd: "Choose the last day of a month." });
  }
}

/** Every asset-month due through `periodEnd` not yet held by a draft or posted run. */
export async function dueDepreciation(db: DbOrTx, ctx: Ctx, periodEnd: string): Promise<DueLine[]> {
  const assets = await db
    .select()
    .from(fixedAssets)
    .where(and(eq(fixedAssets.orgId, ctx.orgId), eq(fixedAssets.status, "active"), ne(fixedAssets.method, "none")))
    .orderBy(asc(fixedAssets.number));
  const out: DueLine[] = [];
  for (const a of assets) {
    if (a.inServiceDate > periodEnd) continue;
    const state = await depreciationState(db, ctx.orgId, a);
    const rows = computeSchedule(scheduleInput(a, ctx.org.baseCurrency), { accumulated: state.heldAccumulated, monthsUsed: state.monthsUsed });
    for (const r of rows) {
      if (r.periodEnd > periodEnd) break;
      if (r.amount.isPositive()) out.push({ assetId: a.id, assetNumber: a.number, assetName: a.name, periodEnd: r.periodEnd, amount: r.amount });
    }
  }
  return out;
}

/** Prepare a draft run for `periodEnd` with everything due (catch-up months included). */
export async function prepareRun(ctx: Ctx, periodEnd: string): Promise<DepreciationRun> {
  requirePermission(ctx, "assets.depreciate");
  assertMonthEnd(periodEnd);
  try {
    return await withTransaction(async (tx) => {
      // One preparer at a time per organization.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`deprun:${ctx.orgId}`}))`);
      const due = await dueDepreciation(tx, ctx, periodEnd);
      if (!due.length) {
        throw new ConflictError(`Nothing is due for depreciation through ${periodEnd}: every asset-month is already in a run.`, "nothing_due");
      }
      const total = Decimal.sum(due.map((d) => d.amount));
      const [run] = await tx
        .insert(depreciationRuns)
        .values({ orgId: ctx.orgId, periodEnd, status: "draft", total: total.toString(), preparedBy: ctx.actor.userId, preparedByLabel: ctx.actor.label })
        .returning();
      await tx.insert(depreciationRunLines).values(
        due.map((d) => ({ orgId: ctx.orgId, runId: run!.id, assetId: d.assetId, periodEnd: d.periodEnd, amount: d.amount.toString(), status: "draft" as const })),
      );
      await audit(tx, ctx, { action: "depreciation.prepared", entityType: "depreciation_run", entityId: run!.id, metadata: { periodEnd, lines: due.length, total: total.toString() } });
      return run!;
    });
  } catch (e) {
    if (pgErrorCode(e) === "23505") throw new ConflictError("Another run took some of these months while this one was being prepared. Refresh and try again.", "concurrent_run");
    throw e;
  }
}

export async function getRun(db: DbOrTx, orgId: string, runId: string) {
  const [run] = await db.select().from(depreciationRuns).where(and(eq(depreciationRuns.orgId, orgId), eq(depreciationRuns.id, runId)));
  if (!run) throw new NotFoundError("The depreciation run");
  const lines = await db
    .select({ line: depreciationRunLines, asset: fixedAssets })
    .from(depreciationRunLines)
    .innerJoin(fixedAssets, and(eq(fixedAssets.orgId, depreciationRunLines.orgId), eq(fixedAssets.id, depreciationRunLines.assetId)))
    .where(and(eq(depreciationRunLines.orgId, orgId), eq(depreciationRunLines.runId, runId)))
    .orderBy(asc(fixedAssets.number), asc(depreciationRunLines.periodEnd));
  return { run, lines };
}

export async function listRuns(db: DbOrTx, orgId: string, limit = 100) {
  return db.select().from(depreciationRuns).where(eq(depreciationRuns.orgId, orgId)).orderBy(desc(depreciationRuns.periodEnd), desc(depreciationRuns.createdAt)).limit(limit);
}

/**
 * Post a reviewed run: one entry on the run's period end, debiting each
 * asset's depreciation expense (with its dimensions) and crediting its
 * accumulated depreciation. Posting a posted run returns it unchanged.
 */
export async function postRun(ctx: Ctx, runId: string): Promise<DepreciationRun> {
  requirePermission(ctx, "assets.depreciate");
  return withTransaction(async (tx) => {
    const [run] = await tx.select().from(depreciationRuns).where(and(eq(depreciationRuns.orgId, ctx.orgId), eq(depreciationRuns.id, runId))).for("update");
    if (!run) throw new NotFoundError("The depreciation run");
    if (run.status === "posted") return run;
    if (run.status === "reversed") throw new ConflictError("This run was reversed. Prepare a new run for the period.", "run_reversed");
    const { lines } = await getRun(tx, ctx.orgId, runId);
    if (!lines.length) throw new ConflictError("This run has no lines left (its assets were disposed of). Discard it.", "empty_run");
    const disposed = lines.filter((l) => l.asset.status === "disposed" || l.asset.status === "draft");
    if (disposed.length) {
      throw new ConflictError(`${disposed[0]!.asset.number} is no longer active. Discard this run and prepare it again.`, "asset_not_active");
    }
    const byAsset = new Map<string, { asset: FixedAsset; amount: Decimal; months: string[] }>();
    for (const { line, asset } of lines) {
      const g = byAsset.get(asset.id) ?? { asset, amount: Decimal.ZERO, months: [] };
      g.amount = g.amount.add(line.amount);
      g.months.push(line.periodEnd.slice(0, 7));
      byAsset.set(asset.id, g);
    }
    const entryLines: LineInput[] = [];
    for (const { asset, amount, months } of byAsset.values()) {
      const span = months.length > 1 ? `${months[0]}–${months[months.length - 1]}` : months[0];
      const dims = { classId: asset.classId, departmentId: asset.departmentId, locationId: asset.locationId, projectId: asset.projectId };
      entryLines.push({ accountId: asset.depreciationExpenseAccountId, amount: amount.toString(), description: `Depreciation ${asset.number} ${asset.name} (${span})`, ...dims });
      entryLines.push({ accountId: asset.accumulatedDepreciationAccountId, amount: amount.neg().toString(), description: `Depreciation ${asset.number} (${span})` });
    }
    const posted = await postEntry(tx, ctx, {
      kind: "depreciation",
      entryDate: run.periodEnd,
      description: `Depreciation through ${run.periodEnd}`,
      sourceType: "depreciation_run",
      sourceId: run.id,
      idempotencyKey: `deprun:${run.id}`,
      isAdjusting: true,
      allowControlAccounts: true,
      lines: entryLines,
    });
    await tx.update(depreciationRunLines).set({ status: "posted" }).where(and(eq(depreciationRunLines.orgId, ctx.orgId), eq(depreciationRunLines.runId, runId)));
    const total = Decimal.sum(lines.map((l) => l.line.amount));
    const [row] = await tx
      .update(depreciationRuns)
      .set({ status: "posted", journalEntryId: posted.entry.id, postedBy: ctx.actor.userId, postedAt: new Date(), total: total.toString() })
      .where(eq(depreciationRuns.id, runId))
      .returning();
    for (const { asset } of byAsset.values()) await refreshStatus(tx, ctx, asset);
    await audit(tx, ctx, { action: "depreciation.posted", entityType: "depreciation_run", entityId: runId, metadata: { periodEnd: run.periodEnd, total: total.toString(), entryId: posted.entry.id } });
    return row!;
  });
}

export async function discardRun(ctx: Ctx, runId: string): Promise<void> {
  requirePermission(ctx, "assets.depreciate");
  await withTransaction(async (tx) => {
    const [run] = await tx.select().from(depreciationRuns).where(and(eq(depreciationRuns.orgId, ctx.orgId), eq(depreciationRuns.id, runId))).for("update");
    if (!run) throw new NotFoundError("The depreciation run");
    if (run.status !== "draft") throw new ConflictError("Only a draft run can be discarded; reverse a posted run.", "not_draft");
    await tx.delete(depreciationRuns).where(eq(depreciationRuns.id, runId));
    await audit(tx, ctx, { action: "depreciation.discarded", entityType: "depreciation_run", entityId: runId, metadata: { periodEnd: run.periodEnd } });
  });
}

/**
 * Reverse a posted run: its entry is reversed on `date` and its asset-months
 * are free to be depreciated again. Runs reverse latest first: refused while
 * any of its assets has depreciation posted for a later month.
 */
export async function reverseRun(ctx: Ctx, runId: string, input: { date?: string | null; reason: string }): Promise<DepreciationRun> {
  requirePermission(ctx, "assets.depreciate");
  if (!input.reason?.trim()) throw new ValidationError("Say why the run is being reversed.", { reason: "Required." });
  return withTransaction(async (tx) => {
    const [run] = await tx.select().from(depreciationRuns).where(and(eq(depreciationRuns.orgId, ctx.orgId), eq(depreciationRuns.id, runId))).for("update");
    if (!run) throw new NotFoundError("The depreciation run");
    if (run.status !== "posted") throw new ConflictError("Only a posted run can be reversed.", "not_posted");
    const lines = await tx.select().from(depreciationRunLines).where(and(eq(depreciationRunLines.orgId, ctx.orgId), eq(depreciationRunLines.runId, runId)));
    const assetIds = [...new Set(lines.map((l) => l.assetId))];
    for (const assetId of assetIds) {
      const last = lines.filter((l) => l.assetId === assetId).reduce((m, l) => (l.periodEnd > m ? l.periodEnd : m), "");
      const [later] = await tx
        .select({ periodEnd: depreciationRunLines.periodEnd })
        .from(depreciationRunLines)
        .where(and(eq(depreciationRunLines.orgId, ctx.orgId), eq(depreciationRunLines.assetId, assetId), eq(depreciationRunLines.status, "posted"), gt(depreciationRunLines.periodEnd, last)))
        .limit(1);
      if (later) throw new ConflictError(`Depreciation for a later month (${later.periodEnd}) is posted for an asset in this run. Reverse the later run first.`, "later_run_posted");
    }
    const [disposed] = await tx
      .select({ number: fixedAssets.number })
      .from(fixedAssets)
      .where(and(eq(fixedAssets.orgId, ctx.orgId), inArray(fixedAssets.id, assetIds), eq(fixedAssets.status, "disposed")))
      .limit(1);
    if (disposed) throw new ConflictError(`${disposed.number} has been disposed of. Reverse the disposal first.`, "asset_disposed");
    const date = input.date && input.date >= run.periodEnd ? input.date : run.periodEnd;
    const rev = await reverseEntryInternal(tx, ctx, run.journalEntryId!, { date, reason: input.reason.trim(), idempotencyKey: `deprun:${run.id}:reverse` });
    await tx.update(depreciationRunLines).set({ status: "reversed" }).where(and(eq(depreciationRunLines.orgId, ctx.orgId), eq(depreciationRunLines.runId, runId)));
    const [row] = await tx
      .update(depreciationRuns)
      .set({ status: "reversed", reversalEntryId: rev.entry.id, reversalReason: input.reason.trim(), reversedAt: new Date() })
      .where(eq(depreciationRuns.id, runId))
      .returning();
    const assets = await tx.select().from(fixedAssets).where(and(eq(fixedAssets.orgId, ctx.orgId), inArray(fixedAssets.id, assetIds)));
    for (const a of assets) await refreshStatus(tx, ctx, a);
    await audit(tx, ctx, { action: "depreciation.reversed", entityType: "depreciation_run", entityId: runId, reason: input.reason.trim(), metadata: { reversalEntryId: rev.entry.id } });
    return row!;
  });
}

export async function getAssetSettings(db: DbOrTx, orgId: string) {
  const [s] = await db.select().from(assetSettings).where(eq(assetSettings.orgId, orgId));
  return { autoPostDepreciation: s?.autoPostDepreciation ?? false };
}

export async function setAutoPostDepreciation(ctx: Ctx, on: boolean): Promise<void> {
  requirePermission(ctx, "assets.depreciate");
  await withTransaction(async (tx) => {
    await tx
      .insert(assetSettings)
      .values({ orgId: ctx.orgId, autoPostDepreciation: on })
      .onConflictDoUpdate({ target: assetSettings.orgId, set: { autoPostDepreciation: on, updatedAt: new Date() } });
    await audit(tx, ctx, { action: on ? "depreciation.auto_post_enabled" : "depreciation.auto_post_disabled", entityType: "organization", entityId: ctx.orgId });
  });
}

/**
 * For the scheduler: prepare the run for the last completed month (or
 * `periodEnd`) if anything is due and no draft is waiting. It stays a draft
 * for review unless the organization turned on automatic posting.
 */
export async function runMonthlyDepreciation(orgId: string, periodEnd?: string): Promise<{ runId: string | null; posted: boolean; reason?: string }> {
  const ctx = await systemCtx(orgId, "job: monthly depreciation");
  const end = periodEnd ?? endOfMonth(addMonths(startOfMonth(todayIn(ctx.org.timezone)), -1));
  assertMonthEnd(end);
  const db = getDb();
  const [waiting] = await db
    .select({ id: depreciationRuns.id })
    .from(depreciationRuns)
    .where(and(eq(depreciationRuns.orgId, orgId), eq(depreciationRuns.status, "draft"), eq(depreciationRuns.periodEnd, end)));
  if (waiting) return { runId: waiting.id, posted: false, reason: "a draft for this month is waiting for review" };
  const due = await dueDepreciation(db, ctx, end);
  if (!due.length) return { runId: null, posted: false, reason: "nothing due" };
  const run = await prepareRun(ctx, end);
  const settings = await getAssetSettings(db, orgId);
  if (settings.autoPostDepreciation && (await isDateOpen(db, ctx.org, end))) {
    await postRun(ctx, run.id);
    return { runId: run.id, posted: true };
  }
  return { runId: run.id, posted: false, reason: settings.autoPostDepreciation ? "the period is closed" : "left for review" };
}

/** Months with depreciation due but not posted, through `periodEnd` (posted runs only). */
export async function unpostedDepreciation(db: DbOrTx, ctx: Ctx, periodEnd: string) {
  const assets = await db
    .select()
    .from(fixedAssets)
    .where(and(eq(fixedAssets.orgId, ctx.orgId), eq(fixedAssets.status, "active"), ne(fixedAssets.method, "none")));
  const out: { asset: FixedAsset; months: string[] }[] = [];
  for (const a of assets) {
    if (a.inServiceDate > periodEnd) continue;
    const state = await depreciationState(db, ctx.orgId, a);
    const rows = computeSchedule(scheduleInput(a, ctx.org.baseCurrency), { accumulated: state.postedAccumulated, monthsUsed: state.postedMonthsUsed }).filter(
      (r) => r.periodEnd <= periodEnd && r.amount.isPositive(),
    );
    if (rows.length) out.push({ asset: a, months: rows.map((r) => r.periodEnd) });
  }
  return out;
}

