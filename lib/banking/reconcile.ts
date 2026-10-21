/**
 * Statement reconciliation.
 *
 * A reconciliation agrees the books with a bank statement: starting from the
 * previous reconciliation's ending balance, the person checks off the ledger
 * lines on the account that appear on the statement. When the opening
 * balance plus the checked lines equals the statement's ending balance, it
 * completes; otherwise it completes only with an explicit, reasoned
 * adjustment posted to Reconciliation Discrepancies. Unchecked lines dated on
 * or before the statement date are its outstanding items. Only the latest
 * completed reconciliation can be undone, with a reason.
 */
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { withTransaction, type DbOrTx } from "@/lib/db/client";
import { reconciliationLines, reconciliations } from "@/lib/db/schema/banking";
import { audit } from "@/lib/audit";
import { requirePermission, type Ctx } from "@/lib/context";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { Decimal } from "@/lib/money/decimal";
import { minorUnits } from "@/lib/money/currency";
import { isIsoDate, todayIn } from "@/lib/dates";
import { postEntry, reverseEntryInternal } from "@/lib/ledger/posting";
import { systemAccountId } from "@/lib/ledger/accounts";
import { resolveRate } from "@/lib/fx/rates";
import { loadMoneyAccount } from "./common";

export type Reconciliation = typeof reconciliations.$inferSelect;

export interface RecLine {
  lineId: string;
  entryId: string;
  entryNumber: number | null;
  entryDate: string;
  kind: string;
  description: string;
  sourceRef: string | null;
  contactName: string | null;
  amount: string;
  /** Matched to a bank transaction. */
  bankMatched: boolean;
  /** Its entry has been reversed (a voided payment, an undone categorization). */
  reversed: boolean;
  /** This line is a reversal of another entry. */
  isReversal: boolean;
  checked: boolean;
}

export async function lastCompleted(db: DbOrTx, orgId: string, accountId: string): Promise<Reconciliation | null> {
  const [r] = await db
    .select()
    .from(reconciliations)
    .where(and(eq(reconciliations.orgId, orgId), eq(reconciliations.accountId, accountId), eq(reconciliations.status, "completed")))
    .orderBy(desc(reconciliations.statementDate), desc(reconciliations.completedAt))
    .limit(1);
  return r ?? null;
}

export async function listReconciliations(db: DbOrTx, orgId: string, opts: { accountId?: string } = {}) {
  const conds = [eq(reconciliations.orgId, orgId)];
  if (opts.accountId) conds.push(eq(reconciliations.accountId, opts.accountId));
  return db.select().from(reconciliations).where(and(...conds)).orderBy(desc(reconciliations.statementDate), desc(reconciliations.createdAt)).limit(200);
}

export async function getReconciliation(db: DbOrTx, orgId: string, id: string): Promise<Reconciliation> {
  const [r] = await db.select().from(reconciliations).where(and(eq(reconciliations.orgId, orgId), eq(reconciliations.id, id)));
  if (!r) throw new NotFoundError("The reconciliation");
  return r;
}

/**
 * The lines a reconciliation works with: everything on the account dated on
 * or before the statement date that no other active reconciliation has
 * cleared, plus whatever this one has checked.
 */
export async function reconciliationLinesFor(db: DbOrTx, ctx: Ctx, rec: Reconciliation): Promise<RecLine[]> {
  const res = await db.execute<{
    line_id: string;
    entry_id: string;
    entry_number: number | null;
    entry_date: string;
    kind: string;
    description: string;
    source_ref: string | null;
    contact_name: string | null;
    amount: string;
    bank_matched: boolean;
    reversed: boolean;
    is_reversal: boolean;
    checked: boolean;
  }>(sql`
    select l.id as line_id, e.id as entry_id, e.entry_number, e.entry_date, e.kind,
           coalesce(nullif(l.description, ''), e.description) as description, e.source_ref, c.display_name as contact_name,
           (case when a.currency is not null then l.txn_amount else l.base_amount end)::text as amount,
           exists (select 1 from bank_match_items mi where mi.org_id = l.org_id and mi.journal_line_id = l.id and mi.active) as bank_matched,
           exists (select 1 from journal_entries r where r.org_id = e.org_id and r.reverses_entry_id = e.id) as reversed,
           (e.reverses_entry_id is not null) as is_reversal,
           exists (select 1 from reconciliation_lines rl where rl.org_id = l.org_id and rl.journal_line_id = l.id and rl.reconciliation_id = ${rec.id} and rl.active) as checked
    from journal_lines l
    join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
    join accounts a on a.org_id = l.org_id and a.id = l.account_id
    left join contacts c on c.org_id = l.org_id and c.id = l.contact_id
    where l.org_id = ${ctx.orgId} and l.account_id = ${rec.accountId} and e.status = 'posted'
      and (
        exists (select 1 from reconciliation_lines rl where rl.org_id = l.org_id and rl.journal_line_id = l.id and rl.reconciliation_id = ${rec.id} and rl.active)
        or (
          e.entry_date <= ${rec.statementDate}
          and not exists (select 1 from reconciliation_lines rl where rl.org_id = l.org_id and rl.journal_line_id = l.id and rl.active)
        )
      )
    order by e.entry_date, e.entry_number, l.line_no
  `);
  return res.rows.map((r) => ({
    lineId: r.line_id,
    entryId: r.entry_id,
    entryNumber: r.entry_number,
    entryDate: r.entry_date,
    kind: r.kind,
    description: r.description,
    sourceRef: r.source_ref,
    contactName: r.contact_name,
    amount: r.amount,
    bankMatched: r.bank_matched,
    reversed: r.reversed,
    isReversal: r.is_reversal,
    checked: r.checked,
  }));
}

export interface RecSummary {
  opening: Decimal;
  clearedIn: Decimal;
  clearedOut: Decimal;
  cleared: Decimal;
  statement: Decimal;
  difference: Decimal;
  outstandingIn: Decimal;
  outstandingOut: Decimal;
  /** Book balance at the statement date (cleared + outstanding). */
  bookBalance: Decimal;
}

export function summarize(rec: Reconciliation, lines: RecLine[]): RecSummary {
  const opening = Decimal.from(rec.openingBalance);
  let clearedIn = Decimal.ZERO;
  let clearedOut = Decimal.ZERO;
  let outIn = Decimal.ZERO;
  let outOut = Decimal.ZERO;
  for (const l of lines) {
    const a = Decimal.from(l.amount);
    if (l.checked) {
      if (a.isPositive()) clearedIn = clearedIn.add(a);
      else clearedOut = clearedOut.add(a);
    } else if (l.entryDate <= rec.statementDate) {
      if (a.isPositive()) outIn = outIn.add(a);
      else outOut = outOut.add(a);
    }
  }
  const cleared = opening.add(clearedIn).add(clearedOut);
  const statement = Decimal.from(rec.statementBalance);
  return {
    opening,
    clearedIn,
    clearedOut,
    cleared,
    statement,
    difference: statement.sub(cleared),
    outstandingIn: outIn,
    outstandingOut: outOut,
    bookBalance: cleared.add(outIn).add(outOut),
  };
}

/** Start a reconciliation; lines already matched to bank transactions on or before the statement date start checked. */
export async function startReconciliation(ctx: Ctx, input: { accountId: string; statementDate: string; statementBalance: string }): Promise<Reconciliation> {
  requirePermission(ctx, "banking.reconcile");
  const fields: Record<string, string> = {};
  if (!isIsoDate(input.statementDate)) fields.statementDate = "Enter the statement's closing date.";
  const bal = Decimal.tryFrom(input.statementBalance?.replace(/[,\s$]/g, "") ?? "");
  if (!bal) fields.statementBalance = "Enter the statement's ending balance.";
  if (Object.keys(fields).length) throw new ValidationError("Check the statement details.", fields);
  return withTransaction(async (tx) => {
    const account = await loadMoneyAccount(tx, ctx, input.accountId);
    if (bal!.decimalPlaces > minorUnits(account.currencyResolved)) throw new ValidationError("The balance has too many decimal places.", { statementBalance: "Too precise." });
    const [open] = await tx
      .select({ id: reconciliations.id })
      .from(reconciliations)
      .where(and(eq(reconciliations.orgId, ctx.orgId), eq(reconciliations.accountId, account.id), eq(reconciliations.status, "in_progress")));
    if (open) throw new ConflictError("A reconciliation of this account is already in progress. Finish or cancel it first.", "in_progress", { id: open.id });
    const last = await lastCompleted(tx, ctx.orgId, account.id);
    if (last && input.statementDate <= last.statementDate) {
      throw new ValidationError(`This account is reconciled through ${last.statementDate}. Use a later statement date.`, { statementDate: `After ${last.statementDate}.` });
    }
    const [rec] = await tx
      .insert(reconciliations)
      .values({
        orgId: ctx.orgId,
        accountId: account.id,
        statementDate: input.statementDate,
        statementBalance: bal!.toString(),
        openingBalance: last ? last.statementBalance : "0",
        createdBy: ctx.actor.userId,
      })
      .returning();
    // Pre-check lines the bank already confirmed (matched) dated within the statement.
    const matched = await tx.execute<{ line_id: string; amount: string }>(sql`
      select l.id as line_id, (case when a.currency is not null then l.txn_amount else l.base_amount end)::text as amount
      from journal_lines l
      join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
      join accounts a on a.org_id = l.org_id and a.id = l.account_id
      join bank_match_items mi on mi.org_id = l.org_id and mi.journal_line_id = l.id and mi.active
      join bank_match_groups g on g.org_id = mi.org_id and g.id = mi.group_id
      where l.org_id = ${ctx.orgId} and l.account_id = ${account.id} and e.status = 'posted' and e.entry_date <= ${input.statementDate}
        and exists (
          select 1 from bank_match_items bi join bank_transactions bt on bt.org_id = bi.org_id and bt.id = bi.bank_transaction_id
          where bi.org_id = g.org_id and bi.group_id = g.id and bi.active and bt.posted_date <= ${input.statementDate}
        )
        and not exists (select 1 from reconciliation_lines rl where rl.org_id = l.org_id and rl.journal_line_id = l.id and rl.active)
    `);
    if (matched.rows.length) {
      await tx.insert(reconciliationLines).values(matched.rows.map((m) => ({ orgId: ctx.orgId, reconciliationId: rec!.id, journalLineId: m.line_id, amount: m.amount })));
    }
    await audit(tx, ctx, { action: "banking.reconciliation_started", entityType: "reconciliation", entityId: rec!.id, metadata: { accountId: account.id, statementDate: input.statementDate, statementBalance: bal!.toString() } });
    return rec!;
  });
}

/** Replace the checked set of an in-progress reconciliation. */
export async function setCleared(ctx: Ctx, recId: string, lineIds: string[]): Promise<RecSummary> {
  requirePermission(ctx, "banking.reconcile");
  return withTransaction(async (tx) => {
    const [rec] = await tx.select().from(reconciliations).where(and(eq(reconciliations.orgId, ctx.orgId), eq(reconciliations.id, recId))).for("update");
    if (!rec) throw new NotFoundError("The reconciliation");
    if (rec.status !== "in_progress") throw new ConflictError("Only a reconciliation in progress can be changed.", "not_in_progress");
    const available = await reconciliationLinesFor(tx, ctx, rec);
    const byId = new Map(available.map((l) => [l.lineId, l]));
    const wanted = [...new Set(lineIds)];
    for (const id of wanted) {
      const l = byId.get(id);
      if (!l) throw new ValidationError("One of the checked lines is not on this account, is dated after the statement, or is cleared elsewhere.");
    }
    await tx.delete(reconciliationLines).where(and(eq(reconciliationLines.orgId, ctx.orgId), eq(reconciliationLines.reconciliationId, recId)));
    if (wanted.length) {
      await tx.insert(reconciliationLines).values(wanted.map((id) => ({ orgId: ctx.orgId, reconciliationId: recId, journalLineId: id, amount: byId.get(id)!.amount })));
    }
    const lines = available.map((l) => ({ ...l, checked: wanted.includes(l.lineId) }));
    return summarize(rec, lines);
  });
}

/**
 * Complete a reconciliation. With a difference, only with `adjust` and a
 * reason: the difference is posted on the statement date to Reconciliation
 * Discrepancies and cleared with the rest.
 */
export async function completeReconciliation(ctx: Ctx, recId: string, opts: { adjustReason?: string | null } = {}): Promise<Reconciliation> {
  requirePermission(ctx, "banking.reconcile");
  return withTransaction(async (tx) => {
    const [rec] = await tx.select().from(reconciliations).where(and(eq(reconciliations.orgId, ctx.orgId), eq(reconciliations.id, recId))).for("update");
    if (!rec) throw new NotFoundError("The reconciliation");
    if (rec.status !== "in_progress") throw new ConflictError("This reconciliation is not in progress.", "not_in_progress");
    const account = await loadMoneyAccount(tx, ctx, rec.accountId);
    const lines = await reconciliationLinesFor(tx, ctx, rec);
    const s = summarize(rec, lines);
    let adjustmentEntryId: string | null = null;
    if (!s.difference.isZero()) {
      if (!opts.adjustReason?.trim()) {
        throw new ConflictError(
          `The cleared balance is ${s.cleared.toString()} and the statement says ${s.statement.toString()}: a difference of ${s.difference.toString()} ${account.currencyResolved}. Find the missing items, or record an adjustment with a reason.`,
          "difference_remaining",
          { difference: s.difference.toString() },
        );
      }
      const fx = account.currencyResolved === ctx.org.baseCurrency ? {} : { fxRate: (await resolveRate(tx, ctx, account.currencyResolved, rec.statementDate)).rate.toString() };
      const discrepancy = await systemAccountId(tx, ctx.orgId, "reconciliation_discrepancies");
      const posted = await postEntry(tx, ctx, {
        kind: "reconciliation_adjustment",
        entryDate: rec.statementDate,
        description: `Reconciliation adjustment for ${account.name} to ${rec.statementDate}: ${opts.adjustReason.trim()}`,
        sourceType: "reconciliation",
        sourceId: rec.id,
        idempotencyKey: `reconcile-adjust:${rec.id}`,
        lines: [
          { accountId: account.id, amount: s.difference.toString(), currency: account.currencyResolved, ...fx, description: "Reconciliation adjustment" },
          { accountId: discrepancy, amount: s.difference.neg().toString(), currency: account.currencyResolved, ...fx, description: opts.adjustReason.trim() },
        ],
      });
      adjustmentEntryId = posted.entry.id;
      const bankLine = posted.lines.find((l) => l.accountId === account.id)!;
      await tx.insert(reconciliationLines).values({ orgId: ctx.orgId, reconciliationId: rec.id, journalLineId: bankLine.id, amount: s.difference.toString() });
    }
    const [done] = await tx
      .update(reconciliations)
      .set({
        status: "completed",
        clearedBalance: s.statement.toString(),
        difference: s.difference.toString(),
        adjustmentEntryId,
        adjustmentReason: adjustmentEntryId ? opts.adjustReason!.trim() : null,
        completedBy: ctx.actor.userId,
        completedAt: new Date(),
      })
      .where(eq(reconciliations.id, rec.id))
      .returning();
    await audit(tx, ctx, {
      action: "banking.reconciled",
      entityType: "reconciliation",
      entityId: rec.id,
      reason: adjustmentEntryId ? opts.adjustReason!.trim() : null,
      metadata: { accountId: rec.accountId, statementDate: rec.statementDate, statementBalance: rec.statementBalance, adjustment: s.difference.toString(), adjustmentEntryId },
    });
    return done!;
  });
}

/** Cancel a reconciliation still in progress (nothing was posted). */
export async function cancelReconciliation(ctx: Ctx, recId: string): Promise<void> {
  requirePermission(ctx, "banking.reconcile");
  await withTransaction(async (tx) => {
    const [rec] = await tx.select().from(reconciliations).where(and(eq(reconciliations.orgId, ctx.orgId), eq(reconciliations.id, recId))).for("update");
    if (!rec) throw new NotFoundError("The reconciliation");
    if (rec.status !== "in_progress") throw new ConflictError("Only a reconciliation in progress can be cancelled; undo a completed one instead.", "not_in_progress");
    await tx.delete(reconciliationLines).where(and(eq(reconciliationLines.orgId, ctx.orgId), eq(reconciliationLines.reconciliationId, recId)));
    await tx.delete(reconciliations).where(eq(reconciliations.id, recId));
    await audit(tx, ctx, { action: "banking.reconciliation_cancelled", entityType: "reconciliation", entityId: recId, metadata: { accountId: rec.accountId, statementDate: rec.statementDate } });
  });
}

/**
 * Undo the latest completed reconciliation of an account: its lines are
 * uncleared, and any adjustment it posted is reversed (dated today, or the
 * statement date if that is later).
 */
export async function undoReconciliation(ctx: Ctx, recId: string, reason: string): Promise<void> {
  requirePermission(ctx, "banking.reconcile.reopen");
  if (!reason?.trim()) throw new ValidationError("Say why the reconciliation is being undone.", { reason: "Required." });
  await withTransaction(async (tx) => {
    const [rec] = await tx.select().from(reconciliations).where(and(eq(reconciliations.orgId, ctx.orgId), eq(reconciliations.id, recId))).for("update");
    if (!rec) throw new NotFoundError("The reconciliation");
    if (rec.status !== "completed") throw new ConflictError("Only a completed reconciliation can be undone.", "not_completed");
    const later = await tx
      .select({ id: reconciliations.id, statementDate: reconciliations.statementDate, status: reconciliations.status })
      .from(reconciliations)
      .where(and(eq(reconciliations.orgId, ctx.orgId), eq(reconciliations.accountId, rec.accountId), ne(reconciliations.id, rec.id), ne(reconciliations.status, "undone")));
    const blocking = later.filter((l) => l.status === "in_progress" || l.statementDate > rec.statementDate);
    if (blocking.length) {
      const b = blocking.sort((x, y) => (x.statementDate < y.statementDate ? 1 : -1))[0]!;
      throw new ConflictError(
        b.status === "in_progress"
          ? "A reconciliation of this account is in progress. Cancel it first."
          : `The reconciliation to ${b.statementDate} comes after this one. Undo the latest first.`,
        "later_reconciliation",
      );
    }
    let reversalId: string | null = null;
    if (rec.adjustmentEntryId) {
      const today = todayIn(ctx.org.timezone);
      const rev = await reverseEntryInternal(tx, ctx, rec.adjustmentEntryId, { date: today < rec.statementDate ? rec.statementDate : today, reason: `Reconciliation undone: ${reason.trim()}` });
      reversalId = rev.entry.id;
    }
    await tx.update(reconciliationLines).set({ active: false }).where(and(eq(reconciliationLines.orgId, ctx.orgId), eq(reconciliationLines.reconciliationId, rec.id)));
    await tx.update(reconciliations).set({ status: "undone", undoneAt: new Date(), undoneBy: ctx.actor.userId, undoReason: reason.trim() }).where(eq(reconciliations.id, rec.id));
    await audit(tx, ctx, { action: "banking.reconciliation_undone", entityType: "reconciliation", entityId: rec.id, reason: reason.trim(), metadata: { adjustmentReversalId: reversalId } });
  });
}

/** For a completed reconciliation: the lines it cleared, and what was outstanding at completion (as now known). */
export async function reconciliationReport(db: DbOrTx, ctx: Ctx, rec: Reconciliation) {
  const cleared = await db.execute<{ line_id: string; entry_id: string; entry_number: number | null; entry_date: string; description: string; amount: string; reversed: boolean }>(sql`
    select l.id as line_id, e.id as entry_id, e.entry_number, e.entry_date, coalesce(nullif(l.description, ''), e.description) as description, rl.amount::text as amount,
           exists (select 1 from journal_entries r where r.org_id = e.org_id and r.reverses_entry_id = e.id) as reversed
    from reconciliation_lines rl
    join journal_lines l on l.org_id = rl.org_id and l.id = rl.journal_line_id
    join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
    where rl.org_id = ${ctx.orgId} and rl.reconciliation_id = ${rec.id}
    order by e.entry_date, e.entry_number
  `);
  // Outstanding: lines dated on or before the statement that this reconciliation did not clear and no earlier one cleared.
  const outstanding = await db.execute<{ line_id: string; entry_id: string; entry_number: number | null; entry_date: string; description: string; amount: string; cleared_later: string | null }>(sql`
    select l.id as line_id, e.id as entry_id, e.entry_number, e.entry_date, coalesce(nullif(l.description, ''), e.description) as description,
           (case when a.currency is not null then l.txn_amount else l.base_amount end)::text as amount,
           (select r2.statement_date::text from reconciliation_lines rl2 join reconciliations r2 on r2.org_id = rl2.org_id and r2.id = rl2.reconciliation_id
              where rl2.org_id = l.org_id and rl2.journal_line_id = l.id and rl2.active and r2.statement_date > ${rec.statementDate} limit 1) as cleared_later
    from journal_lines l
    join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
    join accounts a on a.org_id = l.org_id and a.id = l.account_id
    where l.org_id = ${ctx.orgId} and l.account_id = ${rec.accountId} and e.status = 'posted' and e.entry_date <= ${rec.statementDate}
      and not exists (
        select 1 from reconciliation_lines rl join reconciliations r on r.org_id = rl.org_id and r.id = rl.reconciliation_id
        where rl.org_id = l.org_id and rl.journal_line_id = l.id and (rl.reconciliation_id = ${rec.id} or (rl.active and r.statement_date <= ${rec.statementDate}))
      )
    order by e.entry_date, e.entry_number
  `);
  return { cleared: cleared.rows, outstanding: outstanding.rows };
}

/** Which of these journal lines are cleared by a completed reconciliation (for registers). */
export async function clearedLineIds(db: DbOrTx, orgId: string, lineIds: string[]): Promise<Map<string, string>> {
  if (!lineIds.length) return new Map();
  const rows = await db
    .select({ lineId: reconciliationLines.journalLineId, statementDate: reconciliations.statementDate })
    .from(reconciliationLines)
    .innerJoin(reconciliations, and(eq(reconciliations.orgId, reconciliationLines.orgId), eq(reconciliations.id, reconciliationLines.reconciliationId)))
    .where(and(eq(reconciliationLines.orgId, orgId), inArray(reconciliationLines.journalLineId, lineIds), eq(reconciliationLines.active, true), eq(reconciliations.status, "completed")));
  return new Map(rows.map((r) => [r.lineId, r.statementDate]));
}

