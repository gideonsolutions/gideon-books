/**
 * Settling one open item against another — a payment against invoices, a
 * credit note or deposit against an invoice, a refund against a credit, a
 * vendor payment against bills.
 *
 * Each settlement posts an entry that moves the amount between the two
 * items (so each item's balance stays the sum of its ledger lines), relieves
 * each side at its own historical base value, and books the difference to
 * realized exchange gain or loss. It also writes the cash-basis recognition
 * of any document it relieves (docs/accounting/cash-basis.md).
 */
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import type { Tx, DbOrTx } from "@/lib/db/client";
import { journalEntries, journalLines } from "@/lib/db/schema/ledger";
import { cashBasisLines, documents, settlements } from "@/lib/db/schema/commerce";
import { audit } from "@/lib/audit";
import type { Ctx } from "@/lib/context";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { Decimal, type DecimalInput } from "@/lib/money/decimal";
import { minorUnits } from "@/lib/money/currency";
import { assertIsoDate } from "@/lib/dates";
import { postEntry, reverseEntryInternal } from "@/lib/ledger/posting";
import { systemAccountId } from "@/lib/ledger/accounts";
import { itemBalance, loadOpenItem, openAmount, type ItemRef, type OpenItemInfo } from "./open-items";

export type Settlement = typeof settlements.$inferSelect;

/** Statuses a document moves through as it is settled. */
function settledStatus(info: OpenItemInfo, open: Decimal): string | null {
  if (info.ref.type !== "document") return null;
  if (info.status === "void" || info.status === "draft") return null;
  if (open.isZero()) return info.kind === "invoice" || info.kind === "bill" ? "paid" : "closed";
  if (open.lt(info.total)) return info.kind === "invoice" || info.kind === "bill" ? "partially_paid" : "issued";
  return "issued";
}

async function refreshDocumentStatus(tx: Tx, ctx: Ctx, ref: ItemRef) {
  if (ref.type !== "document") return;
  const info = await loadOpenItem(tx, ctx.orgId, ref);
  const bal = await itemBalance(tx, ctx.orgId, ref.id);
  const status = settledStatus(info, openAmount(info, bal));
  if (status && status !== info.status) {
    await tx
      .update(documents)
      .set({ status: status as never, updatedAt: new Date() })
      .where(and(eq(documents.orgId, ctx.orgId), eq(documents.id, ref.id)));
  }
}

/**
 * Base value relieved when `amount` of an item's open `txn` is settled:
 * all of it on the final settlement, otherwise pro rata, rounded half-up.
 */
function relieve(openTxn: Decimal, openBase: Decimal, amount: Decimal, baseCurrency: string): Decimal {
  if (amount.eq(openTxn)) return openBase;
  return openBase.mulDiv(amount, openTxn, minorUnits(baseCurrency), "half_up");
}

export interface SettleInput {
  debit: ItemRef;
  credit: ItemRef;
  amount: DecimalInput;
  date: string;
  idempotencyKey?: string | null;
}

export async function settle(tx: Tx, ctx: Ctx, input: SettleInput): Promise<Settlement> {
  assertIsoDate(input.date, "settlement date");
  const amount = Decimal.from(input.amount);
  if (!amount.isPositive()) throw new ValidationError("The amount applied must be more than zero.", { amount: "Must be positive." });
  if (input.debit.id === input.credit.id) throw new ValidationError("An item cannot settle itself.");

  // Lock both items in a fixed order so two settlements touching the same
  // pair cannot deadlock or over-apply.
  const [first, second] = input.debit.id < input.credit.id ? [input.debit, input.credit] : [input.credit, input.debit];
  const a = await loadOpenItem(tx, ctx.orgId, first, true);
  const b = await loadOpenItem(tx, ctx.orgId, second, true);
  const debit = a.ref.id === input.debit.id ? a : b;
  const credit = a.ref.id === input.credit.id ? a : b;

  if (debit.nature !== "debit") throw new ValidationError(`${label(debit)} does not carry a debit balance; it cannot be paid by ${label(credit)}.`);
  if (credit.nature !== "credit") throw new ValidationError(`${label(credit)} does not carry a credit balance.`);
  if (debit.side !== credit.side) throw new ValidationError("A receivable cannot be settled against a payable.");
  if (debit.contactId !== credit.contactId) throw new ValidationError("Both items must belong to the same customer or vendor.");
  if (debit.currency !== credit.currency) {
    throw new ValidationError(`${label(debit)} is in ${debit.currency} and ${label(credit)} is in ${credit.currency}; settle items in the same currency.`);
  }
  for (const i of [debit, credit]) {
    if (i.status === "void" || i.status === "draft") throw new ConflictError(`${label(i)} is ${i.status}; it cannot be settled.`, "item_not_open");
  }
  const mu = minorUnits(debit.currency);
  if (amount.decimalPlaces > mu) throw new ValidationError(`The amount has more than ${mu} decimal places.`, { amount: "Too precise." });
  const latest = debit.date > credit.date ? debit.date : credit.date;
  if (input.date < latest) {
    throw new ValidationError(`A settlement cannot be dated before both items exist (${latest}).`, { date: `On or after ${latest}.` });
  }

  const debitBal = await itemBalance(tx, ctx.orgId, debit.ref.id);
  const creditBal = await itemBalance(tx, ctx.orgId, credit.ref.id);
  const debitOpen = openAmount(debit, debitBal);
  const creditOpen = openAmount(credit, creditBal);
  if (amount.gt(debitOpen)) {
    throw new ConflictError(`Only ${debitOpen.toString()} ${debit.currency} is open on ${label(debit)}.`, "over_application", { open: debitOpen.toString() });
  }
  if (amount.gt(creditOpen)) {
    throw new ConflictError(`Only ${creditOpen.toString()} ${credit.currency} is available on ${label(credit)}.`, "over_application", { available: creditOpen.toString() });
  }
  if (!debitBal.accountId || !creditBal.accountId) throw new Error("open item without a ledger line");

  const base = ctx.org.baseCurrency;
  const debitBase = relieve(debitBal.txn, debitBal.base, amount, base); // positive
  const creditBase = relieve(creditBal.txn.neg(), creditBal.base.neg(), amount, base); // positive
  const fx = debitBase.sub(creditBase); // + = loss (debit to FX), − = gain

  const [row] = await tx
    .insert(settlements)
    .values({
      orgId: ctx.orgId,
      settlementDate: input.date,
      side: debit.side,
      contactId: debit.contactId,
      debitItemType: debit.ref.type,
      debitItemId: debit.ref.id,
      creditItemType: credit.ref.type,
      creditItemId: credit.ref.id,
      currency: debit.currency,
      amount: amount.rescale(mu).toString(),
      debitBase: debitBase.toString(),
      creditBase: creditBase.toString(),
      fxDifferenceBase: fx.neg().toString(),
      createdBy: ctx.actor.userId,
    })
    .returning();

  const lines = [
    {
      accountId: creditBal.accountId,
      amount: amount.toString(),
      currency: credit.currency,
      baseAmount: creditBase.toString(),
      contactId: credit.contactId,
      openItem: credit.ref,
      description: `${label(credit)} applied to ${label(debit)}`,
    },
    {
      accountId: debitBal.accountId,
      amount: amount.neg().toString(),
      currency: debit.currency,
      baseAmount: debitBase.neg().toString(),
      contactId: debit.contactId,
      openItem: debit.ref,
      description: `${label(debit)} settled by ${label(credit)}`,
    },
  ];
  if (!fx.isZero()) {
    lines.push({
      accountId: await systemAccountId(tx, ctx.orgId, "realized_fx"),
      amount: fx.toString(),
      currency: base,
      baseAmount: fx.toString(),
      contactId: debit.contactId,
      openItem: null as never,
      description: fx.isPositive() ? "Realized exchange loss" : "Realized exchange gain",
    });
  }
  const posted = await postEntry(tx, ctx, {
    kind: "settlement",
    entryDate: input.date,
    description: `${label(credit)} applied to ${label(debit)}`,
    sourceType: "settlement",
    sourceId: row!.id,
    sourceRef: [credit.number, debit.number].filter(Boolean).join(" → ") || null,
    idempotencyKey: input.idempotencyKey ?? null,
    cashBasis: "settlement",
    allowControlAccounts: true,
    lines,
  });
  await tx.update(settlements).set({ journalEntryId: posted.entry.id }).where(eq(settlements.id, row!.id));

  // Cash basis: recognize each document side pro rata.
  for (const [info, relievedBase, relievedTxn] of [
    [debit, debitBase, amount],
    [credit, creditBase, amount],
  ] as const) {
    if (!info.isCash) await recognizeDocument(tx, ctx, info, row!.id, posted.entry.id, input.date, relievedBase, relievedTxn);
  }

  await refreshDocumentStatus(tx, ctx, debit.ref);
  await refreshDocumentStatus(tx, ctx, credit.ref);
  await audit(tx, ctx, {
    action: "settlement.created",
    entityType: "settlement",
    entityId: row!.id,
    metadata: { debit: debit.ref, credit: credit.ref, amount: amount.toString(), currency: debit.currency, fxDifference: fx.neg().toString() },
  });
  return { ...row!, journalEntryId: posted.entry.id };
}

function label(i: OpenItemInfo): string {
  const kind = i.kind.replace(/_/g, " ");
  return i.number ? `${kind} ${i.number}` : kind;
}

/**
 * Write the cash-basis recognition of `relievedBase` of a document: its own
 * non-control lines, pro rata, dated the settlement date. On the settlement
 * that clears the document, each line takes exactly what is left, so the
 * recognized totals equal the document.
 */
async function recognizeDocument(
  tx: Tx,
  ctx: Ctx,
  info: OpenItemInfo,
  settlementId: string,
  entryId: string,
  date: string,
  relievedBase: Decimal,
  relievedTxn: Decimal,
) {
  if (!info.journalEntryId) return;
  const docLines = await tx
    .select()
    .from(journalLines)
    .where(and(eq(journalLines.orgId, ctx.orgId), eq(journalLines.entryId, info.journalEntryId)))
    .orderBy(asc(journalLines.lineNo));
  const control = docLines.filter((l) => l.openItemId === info.ref.id);
  const others = docLines.filter((l) => l.openItemId !== info.ref.id);
  if (!control.length || !others.length) return;
  const docBase = Decimal.sum(control.map((l) => l.baseAmount)).abs();
  const docTxn = Decimal.sum(control.map((l) => l.txnAmount)).abs();
  if (docBase.isZero() && docTxn.isZero()) return;

  const bal = await itemBalance(tx, ctx.orgId, info.ref.id);
  const clears = bal.txn.isZero() && bal.base.isZero();

  const prior = await tx
    .select({
      sourceLineId: cashBasisLines.sourceLineId,
      base: sql<string>`sum(${cashBasisLines.baseAmount})::text`,
      txn: sql<string>`sum(${cashBasisLines.txnAmount})::text`,
    })
    .from(cashBasisLines)
    .where(and(eq(cashBasisLines.orgId, ctx.orgId), inArray(cashBasisLines.sourceLineId, others.map((l) => l.id))))
    .groupBy(cashBasisLines.sourceLineId);
  const priorMap = new Map(prior.map((p) => [p.sourceLineId, p]));
  const baseMu = minorUnits(ctx.org.baseCurrency);

  let recognized: { line: (typeof others)[number]; base: Decimal; txn: Decimal }[];
  if (clears) {
    recognized = others.map((l) => {
      const p = priorMap.get(l.id);
      return {
        line: l,
        base: Decimal.from(l.baseAmount).sub(p?.base ?? "0"),
        txn: Decimal.from(l.txnAmount).sub(p?.txn ?? "0"),
      };
    });
  } else {
    // Pro rata on base, with the rounding remainder on the largest line so the parts sum to the relief exactly.
    const sign = Decimal.sum(others.map((l) => l.baseAmount)).sign() || -1;
    const targetBase = sign < 0 ? relievedBase.neg() : relievedBase;
    const raw = others.map((l) => ({
      line: l,
      base: docBase.isZero() ? Decimal.ZERO.rescale(baseMu) : Decimal.from(l.baseAmount).mulDiv(relievedBase, docBase, baseMu, "half_up"),
      txn: docTxn.isZero() ? Decimal.ZERO : Decimal.from(l.txnAmount).mulDiv(relievedTxn, docTxn, minorUnits(l.currency), "half_up"),
    }));
    const diff = targetBase.sub(Decimal.sum(raw.map((r) => r.base)));
    if (!diff.isZero()) {
      let k = 0;
      raw.forEach((r, i) => {
        if (r.base.abs().gt(raw[k]!.base.abs())) k = i;
      });
      raw[k]!.base = raw[k]!.base.add(diff);
    }
    recognized = raw;
  }
  const rows = recognized
    .filter((r) => !r.base.isZero() || !r.txn.isZero())
    .map((r) => ({
      orgId: ctx.orgId,
      entryId,
      settlementId,
      entryDate: date,
      sourceEntryId: info.journalEntryId!,
      sourceLineId: r.line.id,
      accountId: r.line.accountId,
      baseAmount: r.base.toString(),
      currency: r.line.currency,
      txnAmount: r.txn.toString(),
      contactId: r.line.contactId,
      itemId: r.line.itemId,
      projectId: r.line.projectId,
      classId: r.line.classId,
      departmentId: r.line.departmentId,
      locationId: r.line.locationId,
      fundId: r.line.fundId,
      trustComponent: r.line.trustComponent,
      beneficiaryId: r.line.beneficiaryId,
    }));
  if (rows.length) await tx.insert(cashBasisLines).values(rows);
}

/**
 * Undo a settlement: its entry is reversed on `date` and its cash-basis
 * recognition is negated on the same date. The items are open again.
 */
export async function reverseSettlement(tx: Tx, ctx: Ctx, settlementId: string, opts: { date: string; reason: string }): Promise<void> {
  const [s] = await tx
    .select()
    .from(settlements)
    .where(and(eq(settlements.orgId, ctx.orgId), eq(settlements.id, settlementId)))
    .for("update");
  if (!s) throw new NotFoundError("The settlement");
  if (s.status === "reversed") throw new ConflictError("This application was already undone.", "already_reversed");
  if (!s.journalEntryId) throw new Error("settlement without entry");
  const date = opts.date < s.settlementDate ? s.settlementDate : opts.date;
  const rev = await reverseEntryInternal(tx, ctx, s.journalEntryId, { date, reason: opts.reason });
  const recognized = await tx.select().from(cashBasisLines).where(and(eq(cashBasisLines.orgId, ctx.orgId), eq(cashBasisLines.settlementId, s.id)));
  if (recognized.length) {
    await tx.insert(cashBasisLines).values(
      recognized.map((r) => ({
        orgId: ctx.orgId,
        entryId: rev.entry.id,
        settlementId: s.id,
        entryDate: date,
        sourceEntryId: r.sourceEntryId,
        sourceLineId: r.sourceLineId,
        accountId: r.accountId,
        baseAmount: Decimal.from(r.baseAmount).neg().toString(),
        currency: r.currency,
        txnAmount: Decimal.from(r.txnAmount).neg().toString(),
        contactId: r.contactId,
        itemId: r.itemId,
        projectId: r.projectId,
        classId: r.classId,
        departmentId: r.departmentId,
        locationId: r.locationId,
        fundId: r.fundId,
        trustComponent: r.trustComponent,
        beneficiaryId: r.beneficiaryId,
      })),
    );
  }
  await tx
    .update(settlements)
    .set({ status: "reversed", reversedAt: new Date(), reversalEntryId: rev.entry.id, reversalReason: opts.reason })
    .where(eq(settlements.id, s.id));
  await refreshDocumentStatus(tx, ctx, { type: s.debitItemType, id: s.debitItemId });
  await refreshDocumentStatus(tx, ctx, { type: s.creditItemType, id: s.creditItemId });
  await audit(tx, ctx, { action: "settlement.reversed", entityType: "settlement", entityId: s.id, reason: opts.reason });
}

export async function settlementsForItem(db: DbOrTx, orgId: string, itemId: string, opts: { activeOnly?: boolean } = {}): Promise<Settlement[]> {
  const conds = [eq(settlements.orgId, orgId), or(eq(settlements.debitItemId, itemId), eq(settlements.creditItemId, itemId))!];
  if (opts.activeOnly) conds.push(eq(settlements.status, "active"));
  return db.select().from(settlements).where(and(...conds)).orderBy(asc(settlements.settlementDate), asc(settlements.createdAt));
}

export async function settlementEntry(db: DbOrTx, orgId: string, s: Settlement) {
  if (!s.journalEntryId) return null;
  const [e] = await db.select().from(journalEntries).where(and(eq(journalEntries.orgId, orgId), eq(journalEntries.id, s.journalEntryId)));
  return e ?? null;
}
