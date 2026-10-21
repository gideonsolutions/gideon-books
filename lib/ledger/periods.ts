/**
 * Fiscal years and periods, closing and reopening.
 *
 * Fiscal years are created as postings need them: twelve monthly periods
 * starting on the organization's fiscal-year start month. A closed period
 * refuses postings — enforced here and again by the database trigger that
 * validates every posting. Periods close in order and reopen in reverse
 * order; reopening needs `periods.reopen` and a reason, and both are kept in
 * period_events and the audit trail.
 */
import { and, asc, desc, eq, gte, lte, lt, gt } from "drizzle-orm";
import { getDb, withTransaction, type DbOrTx, type Tx } from "@/lib/db/client";
import { fiscalPeriods, fiscalYears, periodEvents } from "@/lib/db/schema/ledger";
import { organizations } from "@/lib/db/schema/core";
import { audit } from "@/lib/audit";
import { requirePermission, type Ctx, type Org } from "@/lib/context";
import { ConflictError, NotFoundError, PostingError, ValidationError } from "@/lib/errors";
import { addMonths, addDays, assertIsoDate, endOfMonth, fromParts, parts } from "@/lib/dates";
import { runCloseChecks, type CloseCheckResult } from "./close-checks";

export type FiscalPeriod = typeof fiscalPeriods.$inferSelect;
export type FiscalYear = typeof fiscalYears.$inferSelect;

/** The first day of the fiscal year containing `date`. */
export function fiscalYearStart(date: string, startMonth: number): string {
  const [y, m] = parts(date);
  const year = m >= startMonth ? y : y - 1;
  return fromParts(year, startMonth, 1);
}

export function fiscalYearName(start: string, startMonth: number): string {
  const end = addDays(addMonths(start, 12), -1);
  const [sy] = parts(start);
  const [ey] = parts(end);
  return startMonth === 1 ? `FY ${sy}` : `FY ${sy}–${String(ey).slice(2)}`;
}

/** Create the fiscal year (and its twelve periods) containing `date` if it does not exist. */
export async function ensureFiscalYear(tx: Tx, org: Pick<Org, "id" | "fiscalYearStartMonth">, date: string): Promise<FiscalYear> {
  assertIsoDate(date);
  const start = fiscalYearStart(date, org.fiscalYearStartMonth);
  const [existing] = await tx
    .select()
    .from(fiscalYears)
    .where(and(eq(fiscalYears.orgId, org.id), eq(fiscalYears.startDate, start)))
    .limit(1);
  if (existing) return existing;
  const end = addDays(addMonths(start, 12), -1);
  await tx
    .insert(fiscalYears)
    .values({ orgId: org.id, name: fiscalYearName(start, org.fiscalYearStartMonth), startDate: start, endDate: end })
    .onConflictDoNothing();
  const [fy] = await tx
    .select()
    .from(fiscalYears)
    .where(and(eq(fiscalYears.orgId, org.id), eq(fiscalYears.startDate, start)))
    .limit(1);
  if (!fy) throw new Error("fiscal year not created");
  const rows = [];
  for (let i = 0; i < 12; i++) {
    const ps = addMonths(start, i);
    rows.push({ orgId: org.id, fiscalYearId: fy.id, periodNo: i + 1, startDate: ps, endDate: endOfMonth(ps) });
  }
  await tx.insert(fiscalPeriods).values(rows).onConflictDoNothing();
  return fy;
}

export async function periodFor(db: DbOrTx, orgId: string, date: string): Promise<FiscalPeriod | null> {
  const [p] = await db
    .select()
    .from(fiscalPeriods)
    .where(and(eq(fiscalPeriods.orgId, orgId), lte(fiscalPeriods.startDate, date), gte(fiscalPeriods.endDate, date)))
    .limit(1);
  return p ?? null;
}

/**
 * The period a posting dated `date` falls in, created if needed, refusing
 * a closed period or a date on or before the lock date.
 */
export async function openPeriodFor(tx: Tx, org: Org, date: string): Promise<FiscalPeriod> {
  if (org.lockDate && date <= org.lockDate) {
    throw new PostingError(
      `The books are locked through ${org.lockDate}. Post on a later date, or ask an administrator to move the lock date.`,
      "locked_date",
      { lockDate: org.lockDate, date },
    );
  }
  await ensureFiscalYear(tx, org, date);
  const p = await periodFor(tx, org.id, date);
  if (!p) throw new Error(`no fiscal period for ${date}`);
  if (p.status !== "open") {
    throw new PostingError(`The period ${p.startDate} to ${p.endDate} is closed. Reopen it (with a reason) or post in an open period.`, "period_closed", {
      periodId: p.id,
      date,
    });
  }
  return p;
}

/** Whether a date can take postings, without creating anything. */
export async function isDateOpen(db: DbOrTx, org: Org, date: string): Promise<boolean> {
  if (org.lockDate && date <= org.lockDate) return false;
  const p = await periodFor(db, org.id, date);
  return !p || p.status === "open";
}

export async function listFiscalYears(db: DbOrTx, orgId: string) {
  const years = await db.select().from(fiscalYears).where(eq(fiscalYears.orgId, orgId)).orderBy(desc(fiscalYears.startDate));
  const periods = await db.select().from(fiscalPeriods).where(eq(fiscalPeriods.orgId, orgId)).orderBy(asc(fiscalPeriods.startDate));
  return years.map((y) => ({ ...y, periods: periods.filter((p) => p.fiscalYearId === y.id) }));
}

export async function getPeriod(db: DbOrTx, orgId: string, periodId: string): Promise<FiscalPeriod> {
  const [p] = await db.select().from(fiscalPeriods).where(and(eq(fiscalPeriods.orgId, orgId), eq(fiscalPeriods.id, periodId))).limit(1);
  if (!p) throw new NotFoundError("The period");
  return p;
}

export async function previewClose(db: DbOrTx, ctx: Ctx, periodId: string): Promise<{ period: FiscalPeriod; checks: CloseCheckResult[] }> {
  requirePermission(ctx, "ledger.read");
  const period = await getPeriod(db, ctx.orgId, periodId);
  const checks = await runCloseChecks(db, ctx, period);
  return { period, checks };
}

/**
 * Close a period. Every earlier period must already be closed. Checks that
 * fail with severity "blocker" stop the close; warnings are recorded with it
 * and need an acknowledgement.
 */
export async function closePeriod(
  ctx: Ctx,
  periodId: string,
  opts: { reason?: string | null; acknowledgeWarnings?: boolean } = {},
): Promise<FiscalPeriod> {
  requirePermission(ctx, "periods.close");
  return withTransaction(async (tx) => {
    const [period] = await tx
      .select()
      .from(fiscalPeriods)
      .where(and(eq(fiscalPeriods.orgId, ctx.orgId), eq(fiscalPeriods.id, periodId)))
      .for("update");
    if (!period) throw new NotFoundError("The period");
    if (period.status === "closed") throw new ConflictError("That period is already closed.", "already_closed");
    const [earlierOpen] = await tx
      .select({ id: fiscalPeriods.id, startDate: fiscalPeriods.startDate })
      .from(fiscalPeriods)
      .where(and(eq(fiscalPeriods.orgId, ctx.orgId), lt(fiscalPeriods.startDate, period.startDate), eq(fiscalPeriods.status, "open")))
      .orderBy(asc(fiscalPeriods.startDate))
      .limit(1);
    if (earlierOpen) {
      throw new ConflictError(`Close the period starting ${earlierOpen.startDate} first; periods close in order.`, "earlier_period_open");
    }
    const checks = await runCloseChecks(tx, ctx, period);
    const blockers = checks.filter((c) => c.status === "fail" && c.severity === "blocker");
    if (blockers.length) {
      throw new ConflictError(`This period cannot close yet: ${blockers.map((b) => b.title).join("; ")}.`, "close_blocked", { checks: blockers });
    }
    const warnings = checks.filter((c) => c.status === "fail" && c.severity === "warning");
    if (warnings.length && !opts.acknowledgeWarnings) {
      throw new ConflictError(`Review before closing: ${warnings.map((w) => w.title).join("; ")}.`, "close_warnings", { checks: warnings });
    }
    const [row] = await tx
      .update(fiscalPeriods)
      .set({ status: "closed", closedAt: new Date(), closedBy: ctx.actor.userId })
      .where(and(eq(fiscalPeriods.orgId, ctx.orgId), eq(fiscalPeriods.id, periodId)))
      .returning();
    await tx.insert(periodEvents).values({
      orgId: ctx.orgId,
      periodId,
      action: "close",
      reason: opts.reason ?? null,
      checklist: checks,
      actorUserId: ctx.actor.userId,
    });
    await audit(tx, ctx, {
      action: "period.closed",
      entityType: "fiscal_period",
      entityId: periodId,
      reason: opts.reason ?? null,
      metadata: { startDate: period.startDate, endDate: period.endDate, warningsAcknowledged: warnings.map((w) => w.key) },
    });
    return row!;
  });
}

/** Reopen a closed period. Later closed periods must be reopened first. */
export async function reopenPeriod(ctx: Ctx, periodId: string, reason: string): Promise<FiscalPeriod> {
  requirePermission(ctx, "periods.reopen");
  if (!reason || reason.trim().length < 5) {
    throw new ValidationError("Say why the period is being reopened.", { reason: "A reason of at least a few words is required." });
  }
  return withTransaction(async (tx) => {
    const [period] = await tx
      .select()
      .from(fiscalPeriods)
      .where(and(eq(fiscalPeriods.orgId, ctx.orgId), eq(fiscalPeriods.id, periodId)))
      .for("update");
    if (!period) throw new NotFoundError("The period");
    if (period.status === "open") throw new ConflictError("That period is already open.", "already_open");
    const [laterClosed] = await tx
      .select({ id: fiscalPeriods.id, startDate: fiscalPeriods.startDate })
      .from(fiscalPeriods)
      .where(and(eq(fiscalPeriods.orgId, ctx.orgId), gt(fiscalPeriods.startDate, period.startDate), eq(fiscalPeriods.status, "closed")))
      .orderBy(desc(fiscalPeriods.startDate))
      .limit(1);
    if (laterClosed) {
      throw new ConflictError(`Reopen the period starting ${laterClosed.startDate} first; periods reopen latest first.`, "later_period_closed");
    }
    const [orgRow] = await tx.select({ lockDate: organizations.lockDate }).from(organizations).where(eq(organizations.id, ctx.orgId));
    if (orgRow?.lockDate && orgRow.lockDate >= period.startDate) {
      throw new ConflictError(`The lock date (${orgRow.lockDate}) covers this period. Move the lock date back first.`, "lock_date_covers");
    }
    const [row] = await tx
      .update(fiscalPeriods)
      .set({ status: "open", closedAt: null, closedBy: null })
      .where(and(eq(fiscalPeriods.orgId, ctx.orgId), eq(fiscalPeriods.id, periodId)))
      .returning();
    await tx.insert(periodEvents).values({ orgId: ctx.orgId, periodId, action: "reopen", reason: reason.trim(), actorUserId: ctx.actor.userId });
    await audit(tx, ctx, {
      action: "period.reopened",
      entityType: "fiscal_period",
      entityId: periodId,
      reason: reason.trim(),
      metadata: { startDate: period.startDate, endDate: period.endDate },
    });
    return row!;
  });
}

/**
 * Set (or clear) the lock date: nothing dated on or before it can be posted,
 * whatever the period status. Moving it backward needs `periods.reopen`.
 */
export async function setLockDate(ctx: Ctx, lockDate: string | null, reason: string): Promise<void> {
  requirePermission(ctx, "periods.close");
  if (lockDate) assertIsoDate(lockDate, "lock date");
  if (!reason || reason.trim().length < 3) throw new ValidationError("Say why the lock date is changing.", { reason: "Required." });
  await withTransaction(async (tx) => {
    const [org] = await tx.select().from(organizations).where(eq(organizations.id, ctx.orgId)).for("update");
    if (!org) throw new NotFoundError("The organization");
    const backward = org.lockDate && (!lockDate || lockDate < org.lockDate);
    if (backward) requirePermission(ctx, "periods.reopen");
    await tx.update(organizations).set({ lockDate, updatedAt: new Date() }).where(eq(organizations.id, ctx.orgId));
    await audit(tx, ctx, {
      action: "books.lock_date_set",
      entityType: "organization",
      entityId: ctx.orgId,
      reason: reason.trim(),
      before: { lockDate: org.lockDate },
      after: { lockDate },
    });
  });
}

export async function periodHistory(db: DbOrTx, orgId: string, periodId?: string) {
  const conds = [eq(periodEvents.orgId, orgId)];
  if (periodId) conds.push(eq(periodEvents.periodId, periodId));
  return db.select().from(periodEvents).where(and(...conds)).orderBy(desc(periodEvents.createdAt)).limit(200);
}

/** Close every open period of a fiscal year in order (year-end close). */
export async function closeFiscalYear(ctx: Ctx, fiscalYearId: string, opts: { reason?: string; acknowledgeWarnings?: boolean } = {}) {
  requirePermission(ctx, "periods.close");
  const periods = await getDb()
    .select()
    .from(fiscalPeriods)
    .where(and(eq(fiscalPeriods.orgId, ctx.orgId), eq(fiscalPeriods.fiscalYearId, fiscalYearId), eq(fiscalPeriods.status, "open")))
    .orderBy(asc(fiscalPeriods.startDate));
  for (const p of periods) await closePeriod(ctx, p.id, opts);
  return periods.length;
}

