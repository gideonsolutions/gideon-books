/**
 * Payments: money received from customers (payments, deposits) or paid to
 * them (refunds), money paid to vendors (payments, prepayments) or received
 * from them (refunds). Recording a payment records it — it never moves money.
 *
 * A payment posts its own entry (bank against the receivable or payable,
 * tagged as an open item), then is applied to documents through settlements:
 * any part not applied stays open as an unapplied credit (or deposit,
 * prepayment) that can be applied or refunded later.
 */
import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import { withTransaction, type DbOrTx, type Tx } from "@/lib/db/client";
import { accounts, contacts, journalEntries } from "@/lib/db/schema/ledger";
import { payments, type PaymentKind } from "@/lib/db/schema/commerce";
import { audit } from "@/lib/audit";
import { requirePermission, type Ctx } from "@/lib/context";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { Decimal } from "@/lib/money/decimal";
import { isCurrency, minorUnits } from "@/lib/money/currency";
import { assertIsoDate, isIsoDate } from "@/lib/dates";
import { resolveRate } from "@/lib/fx/rates";
import { postEntry, reverseEntryInternal, type LineInput } from "@/lib/ledger/posting";
import { systemAccountId } from "@/lib/ledger/accounts";
import { nextNumber } from "@/lib/ledger/sequences";
import type { SystemKey } from "@/lib/ledger/coa-templates";
import { itemBalance, loadOpenItem, openAmount, paymentNature, type ItemRef } from "./open-items";
import { reverseSettlement, settle, settlementsForItem } from "./settlements";

export type Payment = typeof payments.$inferSelect;

export const PAYMENT_KIND_LABELS: Record<PaymentKind, string> = {
  customer_payment: "Customer payment",
  customer_deposit: "Customer deposit",
  customer_refund: "Refund to customer",
  vendor_payment: "Payment to vendor",
  vendor_prepayment: "Vendor prepayment",
  vendor_refund: "Refund from vendor",
};

/** Where each kind's open item sits. */
const OPEN_ITEM_ACCOUNT: Record<PaymentKind, SystemKey> = {
  customer_payment: "accounts_receivable",
  customer_deposit: "customer_deposits",
  customer_refund: "accounts_receivable",
  vendor_payment: "accounts_payable",
  vendor_prepayment: "vendor_prepayments",
  vendor_refund: "accounts_payable",
};

/** Money comes in (bank debited) for these kinds. */
const INFLOW: Record<PaymentKind, boolean> = {
  customer_payment: true,
  customer_deposit: true,
  customer_refund: false,
  vendor_payment: false,
  vendor_prepayment: false,
  vendor_refund: true,
};

export interface AllocationInput {
  /** The document (or, for refunds, the credit note / payment) the money is applied to. */
  itemType: "document" | "payment";
  itemId: string;
  amount: string;
}

export interface PaymentInput {
  kind: PaymentKind;
  contactId: string;
  paymentDate: string;
  accountId: string;
  currency?: string | null;
  amount: string;
  fxRate?: string | null;
  /**
   * When the money account is in the base currency but the payment is in a
   * foreign currency: the base amount that actually moved. It sets the rate.
   */
  accountAmount?: string | null;
  feeAmount?: string | null;
  feeAccountId?: string | null;
  method?: Payment["method"];
  reference?: string | null;
  memo?: string | null;
  allocations?: AllocationInput[];
  provider?: string | null;
  providerRef?: string | null;
}

function dec(v: string | null | undefined): Decimal | null {
  if (v === null || v === undefined || v.trim() === "") return null;
  return Decimal.tryFrom(v.replace(/[,\s$]/g, ""));
}

/**
 * Record a payment and apply it. Runs in its own transaction unless `tx` is
 * given (a provider webhook records a payment and its fee together).
 */
export async function recordPayment(ctx: Ctx, input: PaymentInput, opts: { tx?: Tx; idempotencyKey?: string | null } = {}): Promise<Payment> {
  requirePermission(ctx, "payments.record");
  const run = async (tx: Tx) => {
    if (opts.idempotencyKey) {
      // A retry of a payment already recorded returns it.
      const [prior] = await tx
        .select({ id: journalEntries.id })
        .from(journalEntries)
        .where(and(eq(journalEntries.orgId, ctx.orgId), eq(journalEntries.idempotencyKey, `payment:${opts.idempotencyKey}`)));
      if (prior) {
        const [existing] = await tx.select().from(payments).where(and(eq(payments.orgId, ctx.orgId), eq(payments.journalEntryId, prior.id)));
        if (existing) return existing;
      }
    }
    const fields: Record<string, string> = {};
    if (!isIsoDate(input.paymentDate)) fields.paymentDate = "Enter the payment date.";
    if (!input.contactId) fields.contactId = "Choose who paid or was paid.";
    if (!input.accountId) fields.accountId = "Choose the bank or cash account.";
    const amount = dec(input.amount);
    if (!amount || !amount.isPositive()) fields.amount = "Enter an amount more than zero.";
    const fee = dec(input.feeAmount) ?? Decimal.ZERO;
    if (fee.isNegative()) fields.feeAmount = "The fee cannot be negative.";
    if (!fee.isZero() && input.kind !== "customer_payment") fields.feeAmount = "Fees are recorded on customer payments only.";
    if (amount && fee.gte(amount)) fields.feeAmount = "The fee must be less than the payment.";
    if (Object.keys(fields).length) throw new ValidationError("Check the payment.", fields);

    const [contact] = await tx.select().from(contacts).where(and(eq(contacts.orgId, ctx.orgId), eq(contacts.id, input.contactId)));
    if (!contact) throw new ValidationError("That contact does not exist.", { contactId: "Not found." });
    const customerSide = input.kind.startsWith("customer");
    if (customerSide && !contact.isCustomer) throw new ValidationError(`${contact.displayName} is not a customer.`, { contactId: "Not a customer." });
    if (!customerSide && !contact.isVendor && !contact.isEmployee) throw new ValidationError(`${contact.displayName} is not a vendor.`, { contactId: "Not a vendor." });

    const currency = input.currency || contact.currency || ctx.org.baseCurrency;
    if (!isCurrency(currency)) throw new ValidationError("Unknown currency.", { currency: "Pick a currency." });
    const mu = minorUnits(currency);
    if (amount!.decimalPlaces > mu || fee.decimalPlaces > mu) throw new ValidationError(`Amounts in ${currency} have ${mu} decimal places.`, { amount: "Too precise." });

    const [acc] = await tx.select().from(accounts).where(and(eq(accounts.orgId, ctx.orgId), eq(accounts.id, input.accountId)));
    if (!acc || !["bank", "cash", "clearing", "credit_card"].includes(acc.subtype)) {
      throw new ValidationError("Choose a bank, cash, clearing or credit-card account.", { accountId: "Not a money account." });
    }
    if (acc.isArchived) throw new ValidationError(`${acc.name} is archived.`, { accountId: "Archived." });
    const accountCurrency = acc.currency ?? ctx.org.baseCurrency;
    if (accountCurrency !== currency && accountCurrency !== ctx.org.baseCurrency) {
      throw new ValidationError(`${acc.name} is kept in ${accountCurrency}; record the payment in ${accountCurrency} or through a base-currency account.`, { accountId: "Currency differs." });
    }
    const crossCurrency = accountCurrency !== currency;
    if (crossCurrency && !fee.isZero()) throw new ValidationError("Record a fee only when the payment and account share a currency.", { feeAmount: "Not with a currency conversion." });

    const base = ctx.org.baseCurrency;
    const baseMu = minorUnits(base);
    let rate = Decimal.ONE;
    let exchangeRateId: string | null = null;
    let bankBase: Decimal | null = null;
    if (currency !== base) {
      const accountAmount = dec(input.accountAmount);
      if (crossCurrency && accountAmount) {
        if (!accountAmount.isPositive()) throw new ValidationError("Enter the amount that moved in the account.", { accountAmount: "Must be positive." });
        bankBase = accountAmount.rescale(baseMu);
        const implied = accountAmount.div(amount!, 12, "half_up");
        const r = await resolveRate(tx, ctx, currency, input.paymentDate, implied.toString());
        rate = r.rate;
        exchangeRateId = r.exchangeRateId;
      } else {
        const r = await resolveRate(tx, ctx, currency, input.paymentDate, input.fxRate || null);
        rate = r.rate;
        exchangeRateId = r.exchangeRateId;
      }
    }
    const baseAmount = bankBase ?? amount!.mul(rate).round(baseMu, "half_up");
    const number = (await nextNumber(tx, ctx.orgId, input.kind)).formatted;
    const [pay] = await tx
      .insert(payments)
      .values({
        orgId: ctx.orgId,
        kind: input.kind,
        number,
        contactId: contact.id,
        paymentDate: input.paymentDate,
        accountId: acc.id,
        currency,
        amount: amount!.rescale(mu).toString(),
        fxRate: rate.toString(),
        exchangeRateId,
        baseAmount: baseAmount.toString(),
        feeAmount: fee.rescale(mu).toString(),
        feeAccountId: fee.isZero() ? null : input.feeAccountId || (await systemAccountId(tx, ctx.orgId, "payment_fees")),
        method: input.method ?? "other",
        reference: input.reference?.trim() || null,
        memo: input.memo?.trim() || null,
        provider: input.provider ?? null,
        providerRef: input.providerRef ?? null,
        createdBy: ctx.actor.userId,
      })
      .returning();

    // The entry: money account against the open item.
    const inflow = INFLOW[input.kind];
    const s = inflow ? 1 : -1;
    const openAccount = await systemAccountId(tx, ctx.orgId, OPEN_ITEM_ACCOUNT[input.kind]);
    const fx = currency === base ? {} : { fxRate: rate.toString(), exchangeRateId };
    const feeBase = fee.isZero() ? Decimal.ZERO : fee.mul(rate).round(baseMu, "half_up");
    const lines: LineInput[] = [];
    if (crossCurrency) {
      lines.push({ accountId: acc.id, amount: baseAmount.mul(s).toString(), currency: base, description: memoFor(input, contact.displayName), contactId: contact.id });
    } else {
      lines.push({
        accountId: acc.id,
        amount: amount!.sub(fee).mul(s).toString(),
        currency,
        ...fx,
        baseAmount: baseAmount.sub(feeBase).mul(s).toString(),
        description: memoFor(input, contact.displayName),
        contactId: contact.id,
      });
    }
    if (!fee.isZero()) {
      lines.push({ accountId: pay!.feeAccountId!, amount: fee.toString(), currency, ...fx, baseAmount: feeBase.toString(), description: "Processing fee", contactId: contact.id });
    }
    lines.push({
      accountId: openAccount,
      amount: amount!.mul(-s).toString(),
      currency,
      ...fx,
      baseAmount: baseAmount.mul(-s).toString(),
      contactId: contact.id,
      openItem: { type: "payment", id: pay!.id },
      description: `${PAYMENT_KIND_LABELS[input.kind]} ${number}`,
    });
    const posted = await postEntry(tx, ctx, {
      kind: input.kind,
      entryDate: input.paymentDate,
      description: `${PAYMENT_KIND_LABELS[input.kind]} ${number} — ${contact.displayName}`,
      sourceType: "payment",
      sourceId: pay!.id,
      sourceRef: input.reference?.trim() || number,
      idempotencyKey: opts.idempotencyKey ? `payment:${opts.idempotencyKey}` : null,
      cashBasis: "as_is",
      allowControlAccounts: true,
      lines,
    });
    if (!posted.created) {
      // A retry: the payment already exists. Drop the duplicate row we just inserted.
      await tx.delete(payments).where(eq(payments.id, pay!.id));
      const [existing] = await tx.select().from(payments).where(and(eq(payments.orgId, ctx.orgId), eq(payments.journalEntryId, posted.entry.id)));
      return existing!;
    }
    await tx.update(payments).set({ journalEntryId: posted.entry.id }).where(eq(payments.id, pay!.id));

    for (const a of input.allocations ?? []) {
      const amt = dec(a.amount);
      if (!amt || amt.isZero()) continue;
      const self: ItemRef = { type: "payment", id: pay!.id };
      const other: ItemRef = { type: a.itemType, id: a.itemId };
      const nature = paymentNature(input.kind).nature;
      await settle(tx, ctx, {
        debit: nature === "debit" ? self : other,
        credit: nature === "credit" ? self : other,
        amount: amt.toString(),
        date: input.paymentDate,
      });
    }
    await audit(tx, ctx, {
      action: "payment.recorded",
      entityType: "payment",
      entityId: pay!.id,
      metadata: { kind: input.kind, number, amount: amount!.toString(), currency, allocations: input.allocations ?? [] },
    });
    return { ...pay!, journalEntryId: posted.entry.id };
  };
  return opts.tx ? run(opts.tx) : withTransaction(run);
}

function memoFor(input: PaymentInput, name: string) {
  return input.memo?.trim() || `${PAYMENT_KIND_LABELS[input.kind]} — ${name}`;
}

/**
 * Apply an open credit (an unapplied payment, a credit note, a deposit) to an
 * open debit (an invoice, a refund) — or on the payables side, a vendor
 * payment, prepayment or credit to a bill.
 */
export async function applyCredit(ctx: Ctx, input: { debit: ItemRef; credit: ItemRef; amount: string; date: string }) {
  requirePermission(ctx, "payments.record");
  return withTransaction((tx) => settle(tx, ctx, input));
}

/** Remove an application (the items are open again). */
export async function unapply(ctx: Ctx, settlementId: string, opts: { date: string; reason: string }) {
  requirePermission(ctx, "payments.void");
  if (!opts.reason?.trim()) throw new ValidationError("Say why the application is being removed.", { reason: "Required." });
  assertIsoDate(opts.date);
  return withTransaction((tx) => reverseSettlement(tx, ctx, settlementId, opts));
}

/**
 * Void a payment: its applications are removed and its entry reversed on
 * `date`. A payment that a bank reconciliation has cleared must be unreconciled first.
 */
export async function voidPayment(ctx: Ctx, paymentId: string, opts: { date: string; reason: string }) {
  requirePermission(ctx, "payments.void");
  if (!opts.reason?.trim()) throw new ValidationError("Say why the payment is being voided.", { reason: "Required." });
  assertIsoDate(opts.date, "void date");
  return withTransaction(async (tx) => {
    const [p] = await tx.select().from(payments).where(and(eq(payments.orgId, ctx.orgId), eq(payments.id, paymentId))).for("update");
    if (!p) throw new NotFoundError("The payment");
    if (p.status === "void") throw new ConflictError("This payment is already void.", "already_void");
    const date = opts.date < p.paymentDate ? p.paymentDate : opts.date;
    for (const s of await settlementsForItem(tx, ctx.orgId, paymentId, { activeOnly: true })) {
      await reverseSettlement(tx, ctx, s.id, { date, reason: `Payment voided: ${opts.reason.trim()}` });
    }
    const rev = await reverseEntryInternal(tx, ctx, p.journalEntryId!, { date, reason: `Void: ${opts.reason.trim()}` });
    const [row] = await tx
      .update(payments)
      .set({ status: "void", voidEntryId: rev.entry.id, voidedAt: new Date(), voidReason: opts.reason.trim() })
      .where(eq(payments.id, paymentId))
      .returning();
    await audit(tx, ctx, { action: "payment.voided", entityType: "payment", entityId: paymentId, reason: opts.reason.trim() });
    return row!;
  });
}

export async function getPayment(db: DbOrTx, orgId: string, id: string) {
  const [p] = await db.select().from(payments).where(and(eq(payments.orgId, orgId), eq(payments.id, id)));
  if (!p) throw new NotFoundError("The payment");
  const apps = await settlementsForItem(db, orgId, id);
  const bal = await itemBalance(db, orgId, id);
  const info = await loadOpenItem(db, orgId, { type: "payment", id });
  return { payment: p, settlements: apps, unapplied: openAmount(info, bal).toString() };
}

export interface PaymentFilters {
  kind?: PaymentKind | PaymentKind[];
  side?: "customer" | "vendor";
  contactId?: string;
  accountId?: string;
  from?: string;
  to?: string;
  q?: string;
  status?: "posted" | "void";
  unapplied?: boolean;
  page?: number;
  pageSize?: number;
  sort?: "date_desc" | "date_asc" | "amount_desc" | "amount_asc";
}

export async function listPayments(db: DbOrTx, orgId: string, f: PaymentFilters = {}) {
  const conds: SQL[] = [eq(payments.orgId, orgId)];
  if (f.kind) conds.push(Array.isArray(f.kind) ? inArray(payments.kind, f.kind) : eq(payments.kind, f.kind));
  if (f.side === "customer") conds.push(inArray(payments.kind, ["customer_payment", "customer_deposit", "customer_refund"]));
  if (f.side === "vendor") conds.push(inArray(payments.kind, ["vendor_payment", "vendor_prepayment", "vendor_refund"]));
  if (f.contactId) conds.push(eq(payments.contactId, f.contactId));
  if (f.accountId) conds.push(eq(payments.accountId, f.accountId));
  if (f.status) conds.push(eq(payments.status, f.status));
  if (f.from) conds.push(gte(payments.paymentDate, f.from));
  if (f.to) conds.push(lte(payments.paymentDate, f.to));
  if (f.q) {
    const like = `%${f.q.replace(/[%_]/g, "\\$&")}%`;
    conds.push(or(ilike(payments.number, like), ilike(payments.reference, like), ilike(payments.memo, like), ilike(contacts.displayName, like))!);
  }
  const openExpr = sql<string>`(select coalesce(sum(l.txn_amount), 0)::text from journal_lines l join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id where l.org_id = ${payments.orgId} and l.open_item_id = ${payments.id} and e.status = 'posted')`;
  if (f.unapplied) conds.push(sql`${openExpr}::numeric <> 0`);
  const pageSize = Math.min(Math.max(f.pageSize ?? 50, 1), 500);
  const page = Math.max(f.page ?? 1, 1);
  const order =
    f.sort === "date_asc"
      ? [asc(payments.paymentDate), asc(payments.number)]
      : f.sort === "amount_desc"
        ? [desc(payments.amount)]
        : f.sort === "amount_asc"
          ? [asc(payments.amount)]
          : [desc(payments.paymentDate), desc(payments.createdAt)];
  const where = and(...conds);
  const [rows, [count]] = await Promise.all([
    db
      .select({ payment: payments, contactName: contacts.displayName, accountName: accounts.name, open: openExpr })
      .from(payments)
      .leftJoin(contacts, and(eq(contacts.orgId, payments.orgId), eq(contacts.id, payments.contactId)))
      .leftJoin(accounts, and(eq(accounts.orgId, payments.orgId), eq(accounts.id, payments.accountId)))
      .where(where)
      .orderBy(...order)
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(payments)
      .leftJoin(contacts, and(eq(contacts.orgId, payments.orgId), eq(contacts.id, payments.contactId)))
      .where(where),
  ]);
  return {
    rows: rows.map((r) => ({
      ...r,
      unapplied: (paymentNature(r.payment.kind).nature === "debit" ? Decimal.from(r.open) : Decimal.from(r.open).neg()).toString(),
    })),
    total: count?.n ?? 0,
    page,
    pageSize,
  };
}

