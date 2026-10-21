/**
 * Open items: documents and payments that carry a balance on a receivable,
 * payable, deposit or prepayment account. An item's balance is the sum of
 * the ledger lines tagged with it — the subledger is the ledger, so the two
 * cannot disagree.
 *
 * Receivables: invoices and customer refunds have debit balances; customer
 * payments, credit notes, write-offs and deposits have credit balances.
 * Payables: vendor payments, prepayments and vendor credits have debit
 * balances; bills and vendor refunds have credit balances.
 */
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import type { DbOrTx, Tx } from "@/lib/db/client";
import { journalEntries, journalLines } from "@/lib/db/schema/ledger";
import { documents, payments, type DocumentKind, type PaymentKind } from "@/lib/db/schema/commerce";
import { NotFoundError } from "@/lib/errors";
import { Decimal } from "@/lib/money/decimal";

export type ItemType = "document" | "payment";
export interface ItemRef {
  type: ItemType;
  id: string;
}

export type Side = "receivables" | "payables";

export interface OpenItemInfo {
  ref: ItemRef;
  side: Side;
  /** Which balance the item naturally carries. */
  nature: "debit" | "credit";
  kind: DocumentKind | PaymentKind;
  contactId: string;
  currency: string;
  date: string;
  number: string | null;
  /** Cash items (payments) are kept as-is on the cash basis; documents are recognized as settled. */
  isCash: boolean;
  status: string;
  /** The entry that created the item (its document or payment posting). */
  journalEntryId: string | null;
  total: Decimal;
}

const DOC_NATURE: Partial<Record<DocumentKind, { side: Side; nature: "debit" | "credit" }>> = {
  invoice: { side: "receivables", nature: "debit" },
  credit_note: { side: "receivables", nature: "credit" },
  write_off: { side: "receivables", nature: "credit" },
  bill: { side: "payables", nature: "credit" },
  vendor_credit: { side: "payables", nature: "debit" },
};

const PAYMENT_NATURE: Record<PaymentKind, { side: Side; nature: "debit" | "credit" }> = {
  customer_payment: { side: "receivables", nature: "credit" },
  customer_deposit: { side: "receivables", nature: "credit" },
  customer_refund: { side: "receivables", nature: "debit" },
  vendor_payment: { side: "payables", nature: "debit" },
  vendor_prepayment: { side: "payables", nature: "debit" },
  vendor_refund: { side: "payables", nature: "credit" },
};

export function documentNature(kind: DocumentKind) {
  return DOC_NATURE[kind] ?? null;
}

export function paymentNature(kind: PaymentKind) {
  return PAYMENT_NATURE[kind];
}

/** Load an open item, optionally locking its row (FOR UPDATE) to serialize settlement. */
export async function loadOpenItem(db: DbOrTx, orgId: string, ref: ItemRef, lock = false): Promise<OpenItemInfo> {
  if (ref.type === "document") {
    const q = db.select().from(documents).where(and(eq(documents.orgId, orgId), eq(documents.id, ref.id)));
    const [d] = lock ? await (q as unknown as { for: (s: "update") => Promise<(typeof documents.$inferSelect)[]> }).for("update") : await q;
    if (!d) throw new NotFoundError("The document");
    const n = documentNature(d.kind);
    if (!n) throw new NotFoundError(`An open ${d.kind.replace("_", " ")}`);
    return {
      ref,
      side: n.side,
      nature: n.nature,
      kind: d.kind,
      contactId: d.contactId!,
      currency: d.currency,
      date: d.postingDate ?? d.issueDate,
      number: d.number ?? d.reference,
      isCash: false,
      status: d.status,
      journalEntryId: d.journalEntryId,
      total: Decimal.from(d.total),
    };
  }
  const q = db.select().from(payments).where(and(eq(payments.orgId, orgId), eq(payments.id, ref.id)));
  const [p] = lock ? await (q as unknown as { for: (s: "update") => Promise<(typeof payments.$inferSelect)[]> }).for("update") : await q;
  if (!p) throw new NotFoundError("The payment");
  const n = PAYMENT_NATURE[p.kind];
  return {
    ref,
    side: n.side,
    nature: n.nature,
    kind: p.kind,
    contactId: p.contactId,
    currency: p.currency,
    date: p.paymentDate,
    number: p.number,
    isCash: true,
    status: p.status,
    journalEntryId: p.journalEntryId,
    total: Decimal.from(p.amount),
  };
}

export interface Balance {
  txn: Decimal;
  base: Decimal;
  /** The control account the item sits on. */
  accountId: string | null;
}

/** Balance of one open item (signed: debit positive), optionally as of a date. */
export async function itemBalance(db: DbOrTx, orgId: string, itemId: string, asOf?: string): Promise<Balance> {
  const conds = [eq(journalLines.orgId, orgId), eq(journalLines.openItemId, itemId), eq(journalEntries.status, "posted")];
  if (asOf) conds.push(lte(journalEntries.entryDate, asOf));
  const [r] = await db
    .select({
      txn: sql<string>`coalesce(sum(${journalLines.txnAmount}), 0)::text`,
      base: sql<string>`coalesce(sum(${journalLines.baseAmount}), 0)::text`,
      accountId: sql<string | null>`min(${journalLines.accountId}::text)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, and(eq(journalEntries.id, journalLines.entryId), eq(journalEntries.orgId, journalLines.orgId)))
    .where(and(...conds));
  return { txn: Decimal.from(r?.txn ?? "0"), base: Decimal.from(r?.base ?? "0"), accountId: r?.accountId ?? null };
}

/** Balances of many items at once. */
export async function itemBalances(db: DbOrTx, orgId: string, itemIds: string[], asOf?: string): Promise<Map<string, Balance>> {
  const out = new Map<string, Balance>();
  if (itemIds.length === 0) return out;
  const conds = [eq(journalLines.orgId, orgId), inArray(journalLines.openItemId, itemIds), eq(journalEntries.status, "posted")];
  if (asOf) conds.push(lte(journalEntries.entryDate, asOf));
  const rows = await db
    .select({
      id: journalLines.openItemId,
      txn: sql<string>`coalesce(sum(${journalLines.txnAmount}), 0)::text`,
      base: sql<string>`coalesce(sum(${journalLines.baseAmount}), 0)::text`,
      accountId: sql<string | null>`min(${journalLines.accountId}::text)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, and(eq(journalEntries.id, journalLines.entryId), eq(journalEntries.orgId, journalLines.orgId)))
    .where(and(...conds))
    .groupBy(journalLines.openItemId);
  for (const r of rows) out.set(r.id!, { txn: Decimal.from(r.txn), base: Decimal.from(r.base), accountId: r.accountId });
  for (const id of itemIds) if (!out.has(id)) out.set(id, { txn: Decimal.ZERO, base: Decimal.ZERO, accountId: null });
  return out;
}

/** The amount still open on an item, as a positive number in its currency. */
export function openAmount(info: Pick<OpenItemInfo, "nature">, bal: Balance): Decimal {
  return info.nature === "debit" ? bal.txn : bal.txn.neg();
}

export interface OpenItemRow {
  type: ItemType;
  id: string;
  kind: string;
  number: string | null;
  date: string;
  dueDate: string | null;
  currency: string;
  total: string;
  openTxn: string;
  openBase: string;
  nature: "debit" | "credit";
}

/**
 * Every item for a contact on one side with a non-zero balance (as of a
 * date): what a payment can be applied to, what a statement lists, what
 * aging buckets.
 */
export async function openItemsForContact(db: DbOrTx | Tx, orgId: string, side: Side, contactId: string, asOf?: string): Promise<OpenItemRow[]> {
  const control = side === "receivables" ? ["receivables", "customer_deposits"] : ["payables", "vendor_prepayments"];
  const res = await db.execute<{
    open_item_type: ItemType;
    open_item_id: string;
    txn: string;
    base: string;
  }>(sql`
    select l.open_item_type, l.open_item_id, sum(l.txn_amount)::text as txn, sum(l.base_amount)::text as base
    from journal_lines l
    join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
    join accounts a on a.org_id = l.org_id and a.id = l.account_id
    where l.org_id = ${orgId} and l.contact_id = ${contactId} and e.status = 'posted'
      and a.control in (${sql.join(control.map((c) => sql`${c}`), sql`, `)})
      ${asOf ? sql`and e.entry_date <= ${asOf}` : sql``}
    group by l.open_item_type, l.open_item_id
    having sum(l.txn_amount) <> 0 or sum(l.base_amount) <> 0
  `);
  const docIds = res.rows.filter((r) => r.open_item_type === "document").map((r) => r.open_item_id);
  const payIds = res.rows.filter((r) => r.open_item_type === "payment").map((r) => r.open_item_id);
  const docs = docIds.length ? await db.select().from(documents).where(and(eq(documents.orgId, orgId), inArray(documents.id, docIds))) : [];
  const pays = payIds.length ? await db.select().from(payments).where(and(eq(payments.orgId, orgId), inArray(payments.id, payIds))) : [];
  const out: OpenItemRow[] = [];
  for (const r of res.rows) {
    if (r.open_item_type === "document") {
      const d = docs.find((x) => x.id === r.open_item_id);
      if (!d) continue;
      const n = documentNature(d.kind)!;
      out.push({
        type: "document",
        id: d.id,
        kind: d.kind,
        number: d.number ?? d.reference,
        date: d.issueDate,
        dueDate: d.dueDate,
        currency: d.currency,
        total: d.total,
        openTxn: (n.nature === "debit" ? Decimal.from(r.txn) : Decimal.from(r.txn).neg()).toString(),
        openBase: (n.nature === "debit" ? Decimal.from(r.base) : Decimal.from(r.base).neg()).toString(),
        nature: n.nature,
      });
    } else {
      const p = pays.find((x) => x.id === r.open_item_id);
      if (!p) continue;
      const n = PAYMENT_NATURE[p.kind];
      out.push({
        type: "payment",
        id: p.id,
        kind: p.kind,
        number: p.number,
        date: p.paymentDate,
        dueDate: null,
        currency: p.currency,
        total: p.amount,
        openTxn: (n.nature === "debit" ? Decimal.from(r.txn) : Decimal.from(r.txn).neg()).toString(),
        openBase: (n.nature === "debit" ? Decimal.from(r.base) : Decimal.from(r.base).neg()).toString(),
        nature: n.nature,
      });
    }
  }
  return out.sort((a, b) => (a.date === b.date ? (a.number ?? "").localeCompare(b.number ?? "") : a.date.localeCompare(b.date)));
}
