/**
 * The posting engine. Every module — manual journals, invoices, payments,
 * bank categorization, inventory, depreciation, payroll, revaluation —
 * writes to the ledger through `postEntry` here, and nowhere else.
 *
 * Guarantees (each also enforced by the database where it can be):
 *  - lines balance in base currency to the minor unit (trigger re-checks);
 *  - amounts are exact decimals at their currency's precision, never floats;
 *  - foreign amounts convert at a stated rate, rounded half-up per line, and a
 *    conversion difference within half a minor unit per converted line goes to
 *    the rounding account — anything larger is refused;
 *  - the posting date's period is open and after the lock date (trigger re-checks);
 *  - accounts and dimensions belong to the organization (composite foreign keys),
 *    are not archived, and fit the line (currency, control accounts);
 *  - an entry with an idempotency key is posted once; a retry returns it;
 *  - posted entries never change (trigger); corrections are reversals.
 */
import { createHash } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Tx, DbOrTx } from "@/lib/db/client";
import { pgErrorCode } from "@/lib/db/client";
import {
  accounts,
  contacts,
  dimensionValues,
  journalEntries,
  journalLines,
  projects,
  type EntryKind,
} from "@/lib/db/schema/ledger";
import { audit } from "@/lib/audit";
import type { Ctx } from "@/lib/context";
import { ConflictError, NotFoundError, PostingError, ValidationError } from "@/lib/errors";
import { Decimal, type DecimalInput } from "@/lib/money/decimal";
import { isCurrency, minorUnits } from "@/lib/money/currency";
import { assertIsoDate } from "@/lib/dates";
import { nextNumber } from "./sequences";
import { openPeriodFor } from "./periods";
import { systemAccountId } from "./accounts";

export type JournalEntry = typeof journalEntries.$inferSelect;
export type JournalLine = typeof journalLines.$inferSelect;

export interface Dimensions {
  projectId?: string | null;
  classId?: string | null;
  departmentId?: string | null;
  locationId?: string | null;
  fundId?: string | null;
  trustComponent?: "principal" | "income" | null;
  beneficiaryId?: string | null;
}

export interface LineInput extends Dimensions {
  accountId: string;
  /** Signed amount in `currency`: debit positive, credit negative. */
  amount: DecimalInput;
  /** Defaults to the organization's base currency. */
  currency?: string;
  /** Base-currency units per one unit of `currency`; required for a foreign amount unless baseAmount is given. */
  fxRate?: DecimalInput | null;
  exchangeRateId?: string | null;
  /**
   * The exact base amount, when the caller already has it — a settlement
   * relieving a document at its historical base value. Overrides conversion.
   */
  baseAmount?: DecimalInput | null;
  description?: string | null;
  contactId?: string | null;
  openItem?: { type: "document" | "payment"; id: string } | null;
  itemId?: string | null;
  quantity?: DecimalInput | null;
  taxRateId?: string | null;
  sourceLineId?: string | null;
  billableStatus?: "billable" | "billed" | "not_billable" | null;
}

export interface EntryInput {
  kind: EntryKind;
  entryDate: string;
  documentDate?: string | null;
  description: string;
  sourceType?: string | null;
  sourceId?: string | null;
  sourceRef?: string | null;
  idempotencyKey?: string | null;
  cashBasis?: "as_is" | "deferred" | "settlement";
  reversesEntryId?: string | null;
  reversalReason?: string | null;
  autoReverseOn?: string | null;
  isAdjusting?: boolean;
  lines: LineInput[];
  /**
   * Subledger modules post to control accounts (receivables, payables,
   * inventory, fixed assets, deposits); manual journals may not.
   */
  allowControlAccounts?: boolean;
}

export interface PostResult {
  entry: JournalEntry;
  lines: JournalLine[];
  /** False when an idempotency key matched an entry already posted. */
  created: boolean;
}

interface PreparedLine {
  input: LineInput;
  accountId: string;
  currency: string;
  txn: Decimal;
  base: Decimal;
  fxRate: Decimal;
  converted: boolean;
}

/** A stable hash of what is being posted, to tell a retry from a different request reusing a key. */
export function hashEntryInput(input: EntryInput): string {
  const normalized = {
    kind: input.kind,
    entryDate: input.entryDate,
    documentDate: input.documentDate ?? null,
    description: input.description,
    sourceType: input.sourceType ?? null,
    sourceId: input.sourceId ?? null,
    lines: input.lines.map((l) => ({
      a: l.accountId,
      m: Decimal.from(l.amount).normalize().toString(),
      c: l.currency ?? null,
      r: l.fxRate != null ? Decimal.from(l.fxRate).normalize().toString() : null,
      b: l.baseAmount != null ? Decimal.from(l.baseAmount).normalize().toString() : null,
      ct: l.contactId ?? null,
      oi: l.openItem?.id ?? null,
      d: [l.projectId, l.classId, l.departmentId, l.locationId, l.fundId, l.trustComponent, l.beneficiaryId].map((x) => x ?? null),
    })),
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

async function validateReferences(tx: Tx, ctx: Ctx, lines: LineInput[], allowControl: boolean, kind: EntryKind) {
  const accountIds = [...new Set(lines.map((l) => l.accountId))];
  const accRows = accountIds.length
    ? await tx.select().from(accounts).where(and(eq(accounts.orgId, ctx.orgId), inArray(accounts.id, accountIds)))
    : [];
  const accMap = new Map(accRows.map((a) => [a.id, a]));

  const dimIds = new Set<string>();
  const projectIds = new Set<string>();
  const contactIds = new Set<string>();
  for (const l of lines) {
    for (const d of [l.classId, l.departmentId, l.locationId, l.fundId]) if (d) dimIds.add(d);
    if (l.projectId) projectIds.add(l.projectId);
    if (l.contactId) contactIds.add(l.contactId);
    if (l.beneficiaryId) contactIds.add(l.beneficiaryId);
  }
  const dimRows = dimIds.size
    ? await tx.select().from(dimensionValues).where(and(eq(dimensionValues.orgId, ctx.orgId), inArray(dimensionValues.id, [...dimIds])))
    : [];
  const dimMap = new Map(dimRows.map((d) => [d.id, d]));
  const projRows = projectIds.size
    ? await tx.select({ id: projects.id }).from(projects).where(and(eq(projects.orgId, ctx.orgId), inArray(projects.id, [...projectIds])))
    : [];
  const projSet = new Set(projRows.map((p) => p.id));
  const contactRows = contactIds.size
    ? await tx
        .select({ id: contacts.id, isBeneficiary: contacts.isBeneficiary })
        .from(contacts)
        .where(and(eq(contacts.orgId, ctx.orgId), inArray(contacts.id, [...contactIds])))
    : [];
  const contactMap = new Map(contactRows.map((c) => [c.id, c]));

  lines.forEach((l, i) => {
    const n = i + 1;
    const acc = accMap.get(l.accountId);
    if (!acc) throw new PostingError(`Line ${n}: the account does not exist in this organization.`, "invalid_account", { line: n });
    if (acc.isArchived) throw new PostingError(`Line ${n}: ${acc.code} ${acc.name} is archived.`, "archived_account", { line: n, accountId: acc.id });
    if (acc.control && !allowControlAccounts(allowControl, kind)) {
      throw new PostingError(
        `Line ${n}: ${acc.code} ${acc.name} is a control account kept by its subledger. Use an invoice, bill, payment, credit, stock adjustment or asset record instead of a journal entry.`,
        "control_account",
        { line: n, accountId: acc.id, control: acc.control },
      );
    }
    if (acc.control && ["receivables", "payables", "customer_deposits", "vendor_prepayments"].includes(acc.control)) {
      if (!l.openItem || !l.contactId) {
        throw new PostingError(`Line ${n}: a ${acc.control.replace("_", " ")} line needs the contact and the document or payment it belongs to.`, "open_item_required", {
          line: n,
        });
      }
    }
    const currency = l.currency ?? ctx.org.baseCurrency;
    if (acc.currency && acc.currency !== currency) {
      throw new PostingError(`Line ${n}: ${acc.code} ${acc.name} is kept in ${acc.currency}; this line is in ${currency}.`, "account_currency", {
        line: n,
      });
    }
    const checkDim = (id: string | null | undefined, kind: "class" | "department" | "location" | "fund", label: string) => {
      if (!id) return;
      const d = dimMap.get(id);
      if (!d || d.kind !== kind) throw new PostingError(`Line ${n}: that ${label} does not exist in this organization.`, "invalid_dimension", { line: n, kind });
      if (d.isArchived) throw new PostingError(`Line ${n}: the ${label} “${d.name}” is archived.`, "archived_dimension", { line: n, kind });
    };
    checkDim(l.classId, "class", "class");
    checkDim(l.departmentId, "department", "department");
    checkDim(l.locationId, "location", "location");
    checkDim(l.fundId, "fund", "fund");
    if (l.projectId && !projSet.has(l.projectId)) throw new PostingError(`Line ${n}: that project does not exist in this organization.`, "invalid_project", { line: n });
    if (l.contactId && !contactMap.has(l.contactId)) throw new PostingError(`Line ${n}: that contact does not exist in this organization.`, "invalid_contact", { line: n });
    if (l.beneficiaryId) {
      const b = contactMap.get(l.beneficiaryId);
      if (!b) throw new PostingError(`Line ${n}: that beneficiary does not exist in this organization.`, "invalid_contact", { line: n });
      if (!b.isBeneficiary) throw new PostingError(`Line ${n}: that contact is not marked as a beneficiary.`, "invalid_beneficiary", { line: n });
    }
  });
  return accMap;
}

function allowControlAccounts(allow: boolean, kind: EntryKind): boolean {
  if (kind === "manual") return false;
  return allow;
}

/** Convert and check the lines; returns them ready to insert. Adds a rounding line if conversion needs one. */
async function prepareLines(tx: Tx, ctx: Ctx, input: EntryInput): Promise<PreparedLine[]> {
  const base = ctx.org.baseCurrency;
  const baseMu = minorUnits(base);
  if (input.lines.length < 2) throw new PostingError("An entry needs at least two lines.", "too_few_lines");
  if (input.lines.length > 5000) throw new PostingError("An entry can have at most 5,000 lines.", "too_many_lines");
  const prepared: PreparedLine[] = input.lines.map((l, i) => {
    const n = i + 1;
    const currency = l.currency ?? base;
    if (!isCurrency(currency)) throw new PostingError(`Line ${n}: unknown currency ${currency}.`, "invalid_currency", { line: n });
    let txn: Decimal;
    try {
      txn = Decimal.from(l.amount);
    } catch {
      throw new PostingError(`Line ${n}: the amount is not a number.`, "invalid_amount", { line: n });
    }
    const mu = minorUnits(currency);
    if (txn.decimalPlaces > mu) {
      throw new PostingError(`Line ${n}: ${txn.toString()} has more than ${mu} decimal places for ${currency}.`, "amount_precision", { line: n });
    }
    txn = txn.rescale(mu);
    let fx = Decimal.ONE;
    let baseAmt: Decimal;
    let converted = false;
    if (currency === base) {
      if (l.fxRate != null && !Decimal.from(l.fxRate).eq(1)) {
        throw new PostingError(`Line ${n}: a base-currency line has an exchange rate of 1.`, "invalid_rate", { line: n });
      }
      if (l.baseAmount != null && !Decimal.from(l.baseAmount).eq(txn)) {
        throw new PostingError(`Line ${n}: a base-currency line's base amount must equal its amount.`, "invalid_base", { line: n });
      }
      baseAmt = txn;
    } else if (l.baseAmount != null) {
      baseAmt = Decimal.from(l.baseAmount);
      if (baseAmt.decimalPlaces > baseMu) throw new PostingError(`Line ${n}: base amount has too many decimal places.`, "amount_precision", { line: n });
      baseAmt = baseAmt.rescale(baseMu);
      if (l.fxRate != null) fx = Decimal.from(l.fxRate);
      else if (!txn.isZero()) fx = baseAmt.div(txn, 12, "half_up").abs();
      if (!txn.isZero() && baseAmt.sign() !== 0 && baseAmt.sign() !== txn.sign()) {
        throw new PostingError(`Line ${n}: base and foreign amounts have opposite signs.`, "invalid_base", { line: n });
      }
    } else {
      if (l.fxRate == null) throw new PostingError(`Line ${n}: a ${currency} amount needs an exchange rate to ${base}.`, "rate_required", { line: n });
      fx = Decimal.from(l.fxRate);
      if (!fx.isPositive()) throw new PostingError(`Line ${n}: the exchange rate must be positive.`, "invalid_rate", { line: n });
      baseAmt = txn.mul(fx).round(baseMu, "half_up");
      converted = true;
    }
    if (fx.decimalPlaces > 12) fx = fx.round(12, "half_up");
    return { input: l, accountId: l.accountId, currency, txn, base: baseAmt, fxRate: fx, converted };
  });

  // Same-currency entries must balance in that currency too.
  const currencies = new Set(prepared.map((p) => p.currency));
  if (currencies.size === 1) {
    const only = [...currencies][0]!;
    const sumTxn = Decimal.sum(prepared.map((p) => p.txn));
    if (!sumTxn.isZero()) {
      throw new PostingError(`The entry does not balance: debits and credits differ by ${sumTxn.abs().toString()} ${only}.`, "unbalanced", {
        difference: sumTxn.toString(),
        currency: only,
      });
    }
  }
  const sumBase = Decimal.sum(prepared.map((p) => p.base));
  if (!sumBase.isZero()) {
    const convertedCount = prepared.filter((p) => p.converted).length;
    // Half a minor unit of rounding per converted line is the most that conversion can produce.
    const tolerance = Decimal.of(5n * BigInt(convertedCount), baseMu + 1);
    if (convertedCount === 0 || sumBase.abs().gt(tolerance)) {
      throw new PostingError(`The entry does not balance: debits and credits differ by ${sumBase.abs().toString()} ${base}.`, "unbalanced", {
        difference: sumBase.toString(),
        currency: base,
      });
    }
    const roundingAccountId = await systemAccountId(tx, ctx.orgId, "rounding");
    prepared.push({
      input: { accountId: roundingAccountId, amount: sumBase.neg().toString(), description: "Currency conversion rounding" },
      accountId: roundingAccountId,
      currency: base,
      txn: sumBase.neg(),
      base: sumBase.neg(),
      fxRate: Decimal.ONE,
      converted: false,
    });
  }
  return prepared;
}

function lineRow(ctx: Ctx, entryId: string, p: PreparedLine, lineNo: number) {
  const l = p.input;
  return {
    orgId: ctx.orgId,
    entryId,
    lineNo,
    accountId: p.accountId,
    description: l.description ?? null,
    baseAmount: p.base.toString(),
    currency: p.currency,
    txnAmount: p.txn.toString(),
    fxRate: p.fxRate.toString(),
    exchangeRateId: l.exchangeRateId ?? null,
    contactId: l.contactId ?? null,
    openItemType: l.openItem?.type ?? null,
    openItemId: l.openItem?.id ?? null,
    itemId: l.itemId ?? null,
    quantity: l.quantity != null ? Decimal.from(l.quantity).toString() : null,
    projectId: l.projectId ?? null,
    classId: l.classId ?? null,
    departmentId: l.departmentId ?? null,
    locationId: l.locationId ?? null,
    fundId: l.fundId ?? null,
    trustComponent: l.trustComponent ?? null,
    beneficiaryId: l.beneficiaryId ?? null,
    taxRateId: l.taxRateId ?? null,
    sourceLineId: l.sourceLineId ?? null,
    billableStatus: l.billableStatus ?? null,
  };
}

async function findByIdempotencyKey(db: DbOrTx, orgId: string, key: string) {
  const [e] = await db
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.orgId, orgId), eq(journalEntries.idempotencyKey, key)))
    .limit(1);
  return e ?? null;
}

async function loadLines(db: DbOrTx, orgId: string, entryId: string): Promise<JournalLine[]> {
  return db
    .select()
    .from(journalLines)
    .where(and(eq(journalLines.orgId, orgId), eq(journalLines.entryId, entryId)))
    .orderBy(asc(journalLines.lineNo));
}

/**
 * Post a balanced entry. Runs inside the caller's transaction so a document
 * and its entry commit together.
 */
export async function postEntry(tx: Tx, ctx: Ctx, input: EntryInput): Promise<PostResult> {
  assertIsoDate(input.entryDate, "posting date");
  if (input.documentDate) assertIsoDate(input.documentDate, "document date");
  if (input.autoReverseOn) assertIsoDate(input.autoReverseOn, "reversal date");
  if (ctx.role === "read_only") throw new PostingError("Read-only members cannot post.", "forbidden");
  const requestHash = hashEntryInput(input);

  if (input.idempotencyKey) {
    const existing = await findByIdempotencyKey(tx, ctx.orgId, input.idempotencyKey);
    if (existing) return replay(tx, ctx, existing, requestHash);
  }

  await validateReferences(tx, ctx, input.lines, input.allowControlAccounts ?? false, input.kind);
  const prepared = await prepareLines(tx, ctx, input);
  const period = await openPeriodFor(tx, ctx.org, input.entryDate);

  const insertAndPost = async (sp: Tx): Promise<PostResult> => {
    const { value: entryNumber } = await nextNumber(sp, ctx.orgId, "journal");
    const [draft] = await sp
      .insert(journalEntries)
      .values({
        orgId: ctx.orgId,
        status: "draft",
        kind: input.kind,
        entryDate: input.entryDate,
        documentDate: input.documentDate ?? null,
        description: input.description.slice(0, 1000),
        sourceType: input.sourceType ?? null,
        sourceId: input.sourceId ?? null,
        sourceRef: input.sourceRef ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        requestHash,
        cashBasis: input.cashBasis ?? "as_is",
        reversesEntryId: input.reversesEntryId ?? null,
        reversalReason: input.reversalReason ?? null,
        autoReverseOn: input.autoReverseOn ?? null,
        isAdjusting: input.isAdjusting ?? false,
        origin: ctx.source,
        createdBy: ctx.actor.userId,
      })
      .returning();
    const lines = await sp
      .insert(journalLines)
      .values(prepared.map((p, i) => lineRow(ctx, draft!.id, p, i + 1)))
      .returning();
    const [entry] = await sp
      .update(journalEntries)
      .set({ status: "posted", entryNumber, periodId: period.id, postedAt: new Date(), postedBy: ctx.actor.userId, updatedAt: new Date() })
      .where(and(eq(journalEntries.orgId, ctx.orgId), eq(journalEntries.id, draft!.id)))
      .returning();
    return { entry: entry!, lines: lines.sort((a, b) => a.lineNo - b.lineNo), created: true };
  };

  let result: PostResult;
  if (input.idempotencyKey) {
    try {
      // A savepoint: if a concurrent request with the same key commits first,
      // the unique index refuses this insert and we return that entry instead.
      result = await tx.transaction(async (sp) => insertAndPost(sp as unknown as Tx));
    } catch (err) {
      if (pgErrorCode(err) === "23505") {
        const existing = await findByIdempotencyKey(tx, ctx.orgId, input.idempotencyKey);
        if (existing) return replay(tx, ctx, existing, requestHash);
      }
      throw err;
    }
  } else {
    result = await insertAndPost(tx);
  }

  await audit(tx, ctx, {
    action: input.reversesEntryId ? "journal.reversed" : "journal.posted",
    entityType: "journal_entry",
    entityId: result.entry.id,
    reason: input.reversalReason ?? null,
    metadata: {
      entryNumber: result.entry.entryNumber,
      kind: input.kind,
      entryDate: input.entryDate,
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      reversesEntryId: input.reversesEntryId ?? null,
      total: Decimal.sum(result.lines.filter((l) => Decimal.from(l.baseAmount).isPositive()).map((l) => l.baseAmount)).toString(),
    },
  });
  return result;
}

async function replay(db: DbOrTx, ctx: Ctx, existing: JournalEntry, requestHash: string): Promise<PostResult> {
  if (existing.requestHash && existing.requestHash !== requestHash) {
    throw new ConflictError(
      "That idempotency key was already used for a different entry.",
      "idempotency_key_reused",
      { entryId: existing.id },
    );
  }
  return { entry: existing, lines: await loadLines(db, ctx.orgId, existing.id), created: false };
}

export async function getEntry(db: DbOrTx, orgId: string, entryId: string): Promise<{ entry: JournalEntry; lines: JournalLine[] }> {
  const [entry] = await db
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.orgId, orgId), eq(journalEntries.id, entryId)))
    .limit(1);
  if (!entry) throw new NotFoundError("The journal entry");
  return { entry, lines: await loadLines(db, orgId, entryId) };
}

export async function findReversal(db: DbOrTx, orgId: string, entryId: string): Promise<JournalEntry | null> {
  const [r] = await db
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.orgId, orgId), eq(journalEntries.reversesEntryId, entryId)))
    .limit(1);
  return r ?? null;
}

/**
 * Reverse a posted entry with an opposite entry on `date`, linked to the
 * original. The original is untouched. Modules use this to void their
 * documents; people reverse manual entries through `reverseManualEntry`.
 */
export async function reverseEntryInternal(
  tx: Tx,
  ctx: Ctx,
  entryId: string,
  opts: { date: string; reason: string; idempotencyKey?: string | null },
): Promise<PostResult> {
  if (!opts.reason?.trim()) throw new ValidationError("Say why the entry is being reversed.", { reason: "Required." });
  const [orig] = await tx
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.orgId, ctx.orgId), eq(journalEntries.id, entryId)))
    .for("update");
  if (!orig) throw new NotFoundError("The journal entry");
  if (orig.status !== "posted") throw new ConflictError("Only a posted entry can be reversed; delete a draft instead.", "not_posted");
  if (orig.reversesEntryId) throw new ConflictError("This entry is itself a reversal. Post a new entry instead of reversing a reversal.", "is_reversal");
  const already = await findReversal(tx, ctx.orgId, entryId);
  if (already) throw new ConflictError(`This entry was already reversed by entry ${already.entryNumber}.`, "already_reversed", { reversalId: already.id });
  if (opts.date < orig.entryDate) {
    throw new ValidationError("A reversal cannot be dated before the entry it reverses.", { date: `On or after ${orig.entryDate}.` });
  }
  const lines = await loadLines(tx, ctx.orgId, entryId);
  return postEntry(tx, ctx, {
    kind: orig.kind,
    entryDate: opts.date,
    documentDate: orig.documentDate,
    description: `Reversal of entry ${orig.entryNumber}: ${orig.description}`.slice(0, 1000),
    sourceType: orig.sourceType,
    sourceId: orig.sourceId,
    sourceRef: orig.sourceRef,
    idempotencyKey: opts.idempotencyKey ?? null,
    cashBasis: orig.cashBasis,
    reversesEntryId: orig.id,
    reversalReason: opts.reason.trim(),
    isAdjusting: orig.isAdjusting,
    allowControlAccounts: true,
    lines: lines.map((l) => ({
      accountId: l.accountId,
      amount: Decimal.from(l.txnAmount).neg().toString(),
      currency: l.currency,
      fxRate: l.fxRate,
      exchangeRateId: l.exchangeRateId,
      baseAmount: Decimal.from(l.baseAmount).neg().toString(),
      description: l.description,
      contactId: l.contactId,
      openItem: l.openItemType && l.openItemId ? { type: l.openItemType, id: l.openItemId } : null,
      itemId: l.itemId,
      quantity: l.quantity != null ? Decimal.from(l.quantity).neg().toString() : null,
      projectId: l.projectId,
      classId: l.classId,
      departmentId: l.departmentId,
      locationId: l.locationId,
      fundId: l.fundId,
      trustComponent: l.trustComponent,
      beneficiaryId: l.beneficiaryId,
      taxRateId: l.taxRateId,
      sourceLineId: l.sourceLineId,
    })),
  });
}

/**
 * Post an existing draft entry in place (its id, and so its attachments and
 * links, are kept). `input` is the draft as it now stands.
 */
export async function postDraftInPlace(tx: Tx, ctx: Ctx, draftId: string, input: EntryInput): Promise<PostResult> {
  assertIsoDate(input.entryDate, "posting date");
  const [draft] = await tx
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.orgId, ctx.orgId), eq(journalEntries.id, draftId)))
    .for("update");
  if (!draft) throw new NotFoundError("The draft entry");
  if (draft.status !== "draft") throw new ConflictError("This entry is already posted.", "already_posted");
  await validateReferences(tx, ctx, input.lines, input.allowControlAccounts ?? false, input.kind);
  const prepared = await prepareLines(tx, ctx, input);
  const period = await openPeriodFor(tx, ctx.org, input.entryDate);
  const { value: entryNumber } = await nextNumber(tx, ctx.orgId, "journal");
  await tx.delete(journalLines).where(and(eq(journalLines.orgId, ctx.orgId), eq(journalLines.entryId, draftId)));
  const lines = await tx
    .insert(journalLines)
    .values(prepared.map((p, i) => lineRow(ctx, draftId, p, i + 1)))
    .returning();
  const [entry] = await tx
    .update(journalEntries)
    .set({
      status: "posted",
      entryNumber,
      periodId: period.id,
      entryDate: input.entryDate,
      documentDate: input.documentDate ?? null,
      description: input.description.slice(0, 1000),
      requestHash: hashEntryInput(input),
      isAdjusting: input.isAdjusting ?? false,
      postedAt: new Date(),
      postedBy: ctx.actor.userId,
      updatedAt: new Date(),
    })
    .where(and(eq(journalEntries.orgId, ctx.orgId), eq(journalEntries.id, draftId)))
    .returning();
  await audit(tx, ctx, {
    action: "journal.posted",
    entityType: "journal_entry",
    entityId: draftId,
    metadata: { entryNumber, kind: input.kind, entryDate: input.entryDate, fromDraft: true },
  });
  return { entry: entry!, lines: lines.sort((a, b) => a.lineNo - b.lineNo), created: true };
}

/** Entry kinds a person may reverse directly; the rest are reversed by voiding their source record. */
export const DIRECTLY_REVERSIBLE: readonly EntryKind[] = ["manual", "opening_balance", "reconciliation_adjustment", "intercompany"];
