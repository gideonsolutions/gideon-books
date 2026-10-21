/**
 * Manual journal entries: drafts that can be edited and deleted, posting
 * (which makes them permanent), reversal, and the journal listing.
 */
import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import { withTransaction, type DbOrTx, type Tx } from "@/lib/db/client";
import { journalEntries, journalLines, accounts } from "@/lib/db/schema/ledger";
import { audit } from "@/lib/audit";
import { requirePermission, type Ctx } from "@/lib/context";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { Decimal } from "@/lib/money/decimal";
import { minorUnits } from "@/lib/money/currency";
import { assertIsoDate, isIsoDate } from "@/lib/dates";
import { resolveRate } from "@/lib/fx/rates";
import {
  DIRECTLY_REVERSIBLE,
  getEntry,
  postDraftInPlace,
  postEntry,
  reverseEntryInternal,
  type Dimensions,
  type EntryInput,
  type LineInput,
  type PostResult,
} from "./posting";

export interface ManualLineInput extends Dimensions {
  accountId: string;
  debit?: string | null;
  credit?: string | null;
  description?: string | null;
  contactId?: string | null;
  currency?: string | null;
  fxRate?: string | null;
}

export interface ManualEntryInput {
  entryDate: string;
  description: string;
  reference?: string | null;
  isAdjusting?: boolean;
  /** Reverse automatically on this date (accruals). */
  autoReverseOn?: string | null;
  lines: ManualLineInput[];
}

function parseSide(v: string | null | undefined, label: string, lineNo: number): Decimal | null {
  if (v === null || v === undefined || v.trim() === "") return null;
  const cleaned = v.replace(/,/g, "").trim();
  const d = Decimal.tryFrom(cleaned);
  if (!d) throw new ValidationError(`Line ${lineNo}: the ${label} is not a number.`, { [`lines.${lineNo - 1}.${label}`]: "Not a number." });
  if (d.isNegative()) throw new ValidationError(`Line ${lineNo}: enter a positive ${label}.`, { [`lines.${lineNo - 1}.${label}`]: "Must be positive." });
  return d;
}

/** Turn debit/credit form lines into signed posting lines (rates resolved for foreign lines). */
async function toLineInputs(db: DbOrTx, ctx: Ctx, input: ManualEntryInput): Promise<LineInput[]> {
  const out: LineInput[] = [];
  for (let i = 0; i < input.lines.length; i++) {
    const l = input.lines[i]!;
    const n = i + 1;
    if (!l.accountId) {
      // Fully blank rows from the form are ignored.
      if (!l.debit && !l.credit && !l.description) continue;
      throw new ValidationError(`Line ${n}: choose an account.`, { [`lines.${i}.accountId`]: "Required." });
    }
    const debit = parseSide(l.debit, "debit", n);
    const credit = parseSide(l.credit, "credit", n);
    if (debit && credit && !debit.isZero() && !credit.isZero()) {
      throw new ValidationError(`Line ${n}: enter either a debit or a credit, not both.`, { [`lines.${i}.debit`]: "One side only." });
    }
    const amount = debit && !debit.isZero() ? debit : credit && !credit.isZero() ? credit.neg() : null;
    if (!amount) throw new ValidationError(`Line ${n}: enter an amount.`, { [`lines.${i}.debit`]: "Required." });
    const currency = l.currency || ctx.org.baseCurrency;
    let fxRate: string | undefined;
    let exchangeRateId: string | null = null;
    if (currency !== ctx.org.baseCurrency) {
      const r = await resolveRate(db, ctx, currency, input.entryDate, l.fxRate || null);
      fxRate = r.rate.toString();
      exchangeRateId = r.exchangeRateId;
    }
    out.push({
      accountId: l.accountId,
      amount: amount.toString(),
      currency,
      ...(fxRate ? { fxRate } : {}),
      exchangeRateId,
      description: l.description?.trim() || null,
      contactId: l.contactId || null,
      projectId: l.projectId || null,
      classId: l.classId || null,
      departmentId: l.departmentId || null,
      locationId: l.locationId || null,
      fundId: l.fundId || null,
      trustComponent: l.trustComponent || null,
      beneficiaryId: l.beneficiaryId || null,
    });
  }
  return out;
}

function validateHeader(input: ManualEntryInput) {
  const fields: Record<string, string> = {};
  if (!isIsoDate(input.entryDate)) fields.entryDate = "Enter a date.";
  if (!input.description?.trim()) fields.description = "Describe the entry.";
  if (input.autoReverseOn && (!isIsoDate(input.autoReverseOn) || input.autoReverseOn <= input.entryDate)) {
    fields.autoReverseOn = "Must be a date after the entry date.";
  }
  if (Object.keys(fields).length) throw new ValidationError("Check the entry.", fields);
}

function entryInput(input: ManualEntryInput, lines: LineInput[], idempotencyKey?: string | null): EntryInput {
  return {
    kind: "manual",
    entryDate: input.entryDate,
    description: input.description.trim(),
    sourceRef: input.reference?.trim() || null,
    isAdjusting: input.isAdjusting ?? false,
    autoReverseOn: input.autoReverseOn || null,
    idempotencyKey: idempotencyKey ?? null,
    lines,
  };
}

/** Post a manual entry directly. */
export async function postManualEntry(ctx: Ctx, input: ManualEntryInput, opts: { idempotencyKey?: string | null } = {}): Promise<PostResult> {
  requirePermission(ctx, "ledger.post");
  validateHeader(input);
  return withTransaction(async (tx) => {
    const lines = await toLineInputs(tx, ctx, input);
    return postEntry(tx, ctx, entryInput(input, lines, opts.idempotencyKey));
  });
}

/** Save a draft: lines are stored as entered, with provisional base amounts. */
async function writeDraftLines(tx: Tx, ctx: Ctx, entryId: string, lines: LineInput[]) {
  await tx.delete(journalLines).where(and(eq(journalLines.orgId, ctx.orgId), eq(journalLines.entryId, entryId)));
  if (!lines.length) return;
  const base = ctx.org.baseCurrency;
  await tx.insert(journalLines).values(
    lines.map((l, i) => {
      const currency = l.currency ?? base;
      const txn = Decimal.from(l.amount);
      const rate = l.fxRate ? Decimal.from(l.fxRate) : Decimal.ONE;
      const baseAmt = currency === base ? txn : txn.mul(rate).round(minorUnits(base), "half_up");
      return {
        orgId: ctx.orgId,
        entryId,
        lineNo: i + 1,
        accountId: l.accountId,
        description: l.description ?? null,
        baseAmount: baseAmt.toString(),
        currency,
        txnAmount: txn.toString(),
        fxRate: rate.toString(),
        exchangeRateId: l.exchangeRateId ?? null,
        contactId: l.contactId ?? null,
        projectId: l.projectId ?? null,
        classId: l.classId ?? null,
        departmentId: l.departmentId ?? null,
        locationId: l.locationId ?? null,
        fundId: l.fundId ?? null,
        trustComponent: l.trustComponent ?? null,
        beneficiaryId: l.beneficiaryId ?? null,
      };
    }),
  );
}

export async function saveManualDraft(ctx: Ctx, input: ManualEntryInput, draftId?: string | null): Promise<string> {
  requirePermission(ctx, "ledger.draft");
  validateHeader(input);
  return withTransaction(async (tx) => {
    const lines = await toLineInputs(tx, ctx, input);
    let id = draftId ?? null;
    if (id) {
      const [d] = await tx
        .select()
        .from(journalEntries)
        .where(and(eq(journalEntries.orgId, ctx.orgId), eq(journalEntries.id, id)))
        .for("update");
      if (!d) throw new NotFoundError("The draft entry");
      if (d.status !== "draft" || d.kind !== "manual") throw new ConflictError("Only a manual draft can be edited.", "not_draft");
      await tx
        .update(journalEntries)
        .set({
          entryDate: input.entryDate,
          description: input.description.trim(),
          sourceRef: input.reference?.trim() || null,
          isAdjusting: input.isAdjusting ?? false,
          autoReverseOn: input.autoReverseOn || null,
          updatedAt: new Date(),
        })
        .where(eq(journalEntries.id, id));
    } else {
      const [row] = await tx
        .insert(journalEntries)
        .values({
          orgId: ctx.orgId,
          status: "draft",
          kind: "manual",
          entryDate: input.entryDate,
          description: input.description.trim(),
          sourceRef: input.reference?.trim() || null,
          isAdjusting: input.isAdjusting ?? false,
          autoReverseOn: input.autoReverseOn || null,
          origin: ctx.source,
          createdBy: ctx.actor.userId,
        })
        .returning();
      id = row!.id;
    }
    await writeDraftLines(tx, ctx, id, lines);
    await audit(tx, ctx, { action: draftId ? "journal.draft_updated" : "journal.draft_created", entityType: "journal_entry", entityId: id });
    return id;
  });
}

export async function deleteManualDraft(ctx: Ctx, draftId: string): Promise<void> {
  requirePermission(ctx, "ledger.draft");
  await withTransaction(async (tx) => {
    const [d] = await tx
      .select()
      .from(journalEntries)
      .where(and(eq(journalEntries.orgId, ctx.orgId), eq(journalEntries.id, draftId)))
      .for("update");
    if (!d) throw new NotFoundError("The draft entry");
    if (d.status !== "draft") throw new ConflictError("A posted entry cannot be deleted; reverse it instead.", "posted_immutable");
    await tx.delete(journalEntries).where(eq(journalEntries.id, draftId));
    await audit(tx, ctx, { action: "journal.draft_deleted", entityType: "journal_entry", entityId: draftId, before: d });
  });
}

/** Post a saved draft as it stands. */
export async function postManualDraft(ctx: Ctx, draftId: string): Promise<PostResult> {
  requirePermission(ctx, "ledger.post");
  return withTransaction(async (tx) => {
    const { entry, lines } = await getEntry(tx, ctx.orgId, draftId);
    if (entry.status !== "draft") throw new ConflictError("This entry is already posted.", "already_posted");
    if (entry.kind !== "manual") throw new ConflictError("Only manual drafts are posted here.", "not_manual");
    const input: EntryInput = {
      kind: "manual",
      entryDate: entry.entryDate,
      description: entry.description,
      sourceRef: entry.sourceRef,
      isAdjusting: entry.isAdjusting,
      autoReverseOn: entry.autoReverseOn,
      lines: lines.map((l) => ({
        accountId: l.accountId,
        amount: l.txnAmount,
        currency: l.currency,
        ...(l.currency !== ctx.org.baseCurrency ? { fxRate: l.fxRate } : {}),
        exchangeRateId: l.exchangeRateId,
        description: l.description,
        contactId: l.contactId,
        projectId: l.projectId,
        classId: l.classId,
        departmentId: l.departmentId,
        locationId: l.locationId,
        fundId: l.fundId,
        trustComponent: l.trustComponent,
        beneficiaryId: l.beneficiaryId,
      })),
    };
    return postDraftInPlace(tx, ctx, draftId, input);
  });
}

/** Reverse a manual (or opening-balance) entry. Entries from documents are reversed by voiding the document. */
export async function reverseManualEntry(ctx: Ctx, entryId: string, opts: { date: string; reason: string }): Promise<PostResult> {
  requirePermission(ctx, "ledger.reverse");
  assertIsoDate(opts.date, "reversal date");
  return withTransaction(async (tx) => {
    const { entry } = await getEntry(tx, ctx.orgId, entryId);
    if (!DIRECTLY_REVERSIBLE.includes(entry.kind)) {
      throw new ConflictError(
        `This entry belongs to ${entry.sourceType ? `a ${entry.sourceType.replace(/_/g, " ")}` : "another record"}. Void or correct that record instead, so its subledger stays in step.`,
        "reverse_via_source",
        { sourceType: entry.sourceType, sourceId: entry.sourceId },
      );
    }
    return reverseEntryInternal(tx, ctx, entryId, { date: opts.date, reason: opts.reason });
  });
}

export interface EntryFilters {
  from?: string;
  to?: string;
  status?: "draft" | "posted";
  kind?: string;
  q?: string;
  accountId?: string;
  sourceType?: string;
  sourceId?: string;
  page?: number;
  pageSize?: number;
  sort?: "date_desc" | "date_asc" | "number_desc" | "number_asc";
}

export async function listEntries(db: DbOrTx, orgId: string, f: EntryFilters = {}) {
  const conds: SQL[] = [eq(journalEntries.orgId, orgId)];
  if (f.from) conds.push(gte(journalEntries.entryDate, f.from));
  if (f.to) conds.push(lte(journalEntries.entryDate, f.to));
  if (f.status) conds.push(eq(journalEntries.status, f.status));
  if (f.kind) conds.push(eq(journalEntries.kind, f.kind as never));
  if (f.sourceType) conds.push(eq(journalEntries.sourceType, f.sourceType));
  if (f.sourceId) conds.push(eq(journalEntries.sourceId, f.sourceId));
  if (f.q) {
    const like = `%${f.q.replace(/[%_]/g, "\\$&")}%`;
    const asNumber = /^\d+$/.test(f.q.trim()) ? Number(f.q.trim()) : null;
    conds.push(
      or(
        ilike(journalEntries.description, like),
        ilike(journalEntries.sourceRef, like),
        ...(asNumber !== null ? [eq(journalEntries.entryNumber, asNumber)] : []),
      )!,
    );
  }
  if (f.accountId) {
    conds.push(
      inArray(
        journalEntries.id,
        db.select({ id: journalLines.entryId }).from(journalLines).where(and(eq(journalLines.orgId, orgId), eq(journalLines.accountId, f.accountId))),
      ),
    );
  }
  const pageSize = Math.min(Math.max(f.pageSize ?? 50, 1), 500);
  const page = Math.max(f.page ?? 1, 1);
  const order =
    f.sort === "date_asc"
      ? [asc(journalEntries.entryDate), asc(journalEntries.entryNumber)]
      : f.sort === "number_asc"
        ? [asc(journalEntries.entryNumber)]
        : f.sort === "number_desc"
          ? [desc(journalEntries.entryNumber)]
          : [desc(journalEntries.entryDate), desc(journalEntries.entryNumber)];
  const where = and(...conds);
  const [rows, [count]] = await Promise.all([
    db
      .select({
        entry: journalEntries,
        total: sql<string>`(select coalesce(sum(${journalLines.baseAmount}) filter (where ${journalLines.baseAmount} > 0), 0)::text from ${journalLines} where ${journalLines.entryId} = ${journalEntries.id})`,
        reversedBy: sql<number | null>`(select r.entry_number from journal_entries r where r.org_id = ${journalEntries.orgId} and r.reverses_entry_id = ${journalEntries.id} limit 1)`,
      })
      .from(journalEntries)
      .where(where)
      .orderBy(...order)
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(journalEntries).where(where),
  ]);
  return { rows, total: count?.n ?? 0, page, pageSize };
}

export async function getEntryDetail(db: DbOrTx, orgId: string, entryId: string) {
  const { entry, lines } = await getEntry(db, orgId, entryId);
  const accIds = [...new Set(lines.map((l) => l.accountId))];
  const accRows = accIds.length ? await db.select().from(accounts).where(and(eq(accounts.orgId, orgId), inArray(accounts.id, accIds))) : [];
  const accMap = new Map(accRows.map((a) => [a.id, a]));
  const [reversedBy] = await db
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.orgId, orgId), eq(journalEntries.reversesEntryId, entryId)))
    .limit(1);
  const reverses = entry.reversesEntryId
    ? (await db.select().from(journalEntries).where(and(eq(journalEntries.orgId, orgId), eq(journalEntries.id, entry.reversesEntryId))).limit(1))[0] ?? null
    : null;
  return { entry, lines: lines.map((l) => ({ ...l, account: accMap.get(l.accountId)! })), reversedBy: reversedBy ?? null, reverses };
}

