/**
 * Receivables and payables aging, and customer and vendor balances, as of a
 * date. Built from the open items on the receivable or payable control
 * account (each document's and payment's ledger lines), so the aging total
 * is the control account's balance on that date.
 */
import { sql } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import type { Org } from "@/lib/context";
import { Decimal } from "@/lib/money/decimal";
import { formatDate } from "@/lib/money/format";
import { daysBetween } from "@/lib/dates";
import { KIND_LABELS } from "@/lib/commerce/states";
import { PAYMENT_KIND_LABELS } from "@/lib/commerce/payments";
import type { DocumentKind, PaymentKind } from "@/lib/db/schema/commerce";
import type { ReportRow, ReportTable } from "./table";

export type AgingSide = "receivables" | "payables";
export const BUCKETS = ["Current", "1–30 days", "31–60 days", "61–90 days", "Over 90 days"] as const;

export function bucketFor(daysPastDue: number): number {
  if (daysPastDue <= 0) return 0;
  if (daysPastDue <= 30) return 1;
  if (daysPastDue <= 60) return 2;
  if (daysPastDue <= 90) return 3;
  return 4;
}

export interface AgingItem {
  type: "document" | "payment";
  id: string;
  kind: string;
  number: string | null;
  date: string;
  dueDate: string | null;
  daysPastDue: number;
  bucket: number;
  currency: string;
  /** Open amount in the item's currency (positive = owed to us for receivables, owed by us for payables). */
  openTxn: Decimal;
  /** Open amount in base currency, same sign convention. */
  openBase: Decimal;
}

export interface AgingContact {
  contactId: string;
  name: string;
  buckets: Decimal[];
  total: Decimal;
  items: AgingItem[];
}

export interface Aging {
  side: AgingSide;
  asOf: string;
  contacts: AgingContact[];
  buckets: Decimal[];
  total: Decimal;
  /** Balance of the control account(s) as of the date, same sign convention. */
  controlBalance: Decimal;
  table: ReportTable;
}

export async function aging(db: DbOrTx, org: Org, opts: { side: AgingSide; asOf: string; detail?: boolean; contactId?: string | null }): Promise<Aging> {
  const control = opts.side === "receivables" ? "receivables" : "payables";
  const sign = opts.side === "receivables" ? Decimal.ONE : Decimal.from(-1);
  const res = await db.execute<{
    open_item_type: "document" | "payment";
    open_item_id: string;
    contact_id: string;
    txn: string;
    base: string;
  }>(sql`
    select l.open_item_type, l.open_item_id, min(l.contact_id::text) as contact_id,
           sum(l.txn_amount)::text as txn, sum(l.base_amount)::text as base
    from journal_lines l
    join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
    join accounts a on a.org_id = l.org_id and a.id = l.account_id
    where l.org_id = ${org.id} and e.status = 'posted' and e.entry_date <= ${opts.asOf}
      and a.control = ${control} and l.open_item_id is not null
      ${opts.contactId ? sql`and l.contact_id = ${opts.contactId}::uuid` : sql``}
    group by l.open_item_type, l.open_item_id
    having sum(l.txn_amount) <> 0 or sum(l.base_amount) <> 0
  `);
  const ctl = await db.execute<{ s: string }>(sql`
    select coalesce(sum(l.base_amount), 0)::text as s
    from journal_lines l
    join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
    join accounts a on a.org_id = l.org_id and a.id = l.account_id
    where l.org_id = ${org.id} and e.status = 'posted' and e.entry_date <= ${opts.asOf} and a.control = ${control}
      ${opts.contactId ? sql`and l.contact_id = ${opts.contactId}::uuid` : sql``}
  `);
  const docIds = res.rows.filter((r) => r.open_item_type === "document").map((r) => r.open_item_id);
  const payIds = res.rows.filter((r) => r.open_item_type === "payment").map((r) => r.open_item_id);
  const docs = new Map<string, { kind: DocumentKind; number: string | null; reference: string | null; issue_date: string; due_date: string | null; currency: string }>();
  if (docIds.length) {
    const d = await db.execute<{ id: string; kind: DocumentKind; number: string | null; reference: string | null; issue_date: string; due_date: string | null; currency: string }>(sql`
      select id, kind, number, reference, issue_date, due_date, currency from documents where org_id = ${org.id} and id in (${sql.join(docIds.map((i) => sql`${i}::uuid`), sql`, `)})`);
    for (const r of d.rows) docs.set(r.id, r);
  }
  const pays = new Map<string, { kind: PaymentKind; number: string | null; payment_date: string; currency: string }>();
  if (payIds.length) {
    const p = await db.execute<{ id: string; kind: PaymentKind; number: string | null; payment_date: string; currency: string }>(sql`
      select id, kind, number, payment_date, currency from payments where org_id = ${org.id} and id in (${sql.join(payIds.map((i) => sql`${i}::uuid`), sql`, `)})`);
    for (const r of p.rows) pays.set(r.id, r);
  }
  const contactIds = [...new Set(res.rows.map((r) => r.contact_id))];
  const names = new Map<string, string>();
  if (contactIds.length) {
    const c = await db.execute<{ id: string; display_name: string }>(sql`
      select id, display_name from contacts where org_id = ${org.id} and id in (${sql.join(contactIds.map((i) => sql`${i}::uuid`), sql`, `)})`);
    for (const r of c.rows) names.set(r.id, r.display_name);
  }
  const byContact = new Map<string, AgingContact>();
  for (const r of res.rows) {
    let item: AgingItem;
    if (r.open_item_type === "document") {
      const d = docs.get(r.open_item_id);
      if (!d) continue;
      const due = d.due_date ?? d.issue_date;
      const days = daysBetween(due, opts.asOf);
      item = {
        type: "document",
        id: r.open_item_id,
        kind: KIND_LABELS[d.kind],
        number: d.number ?? d.reference,
        date: d.issue_date,
        dueDate: d.due_date,
        daysPastDue: Math.max(0, days),
        bucket: bucketFor(days),
        currency: d.currency,
        openTxn: Decimal.from(r.txn).mul(sign),
        openBase: Decimal.from(r.base).mul(sign),
      };
    } else {
      const p = pays.get(r.open_item_id);
      if (!p) continue;
      // Unapplied payments and refunds are not due; they sit in the current column.
      item = {
        type: "payment",
        id: r.open_item_id,
        kind: PAYMENT_KIND_LABELS[p.kind],
        number: p.number,
        date: p.payment_date,
        dueDate: null,
        daysPastDue: 0,
        bucket: 0,
        currency: p.currency,
        openTxn: Decimal.from(r.txn).mul(sign),
        openBase: Decimal.from(r.base).mul(sign),
      };
    }
    const c = byContact.get(r.contact_id) ?? { contactId: r.contact_id, name: names.get(r.contact_id) ?? "Unknown contact", buckets: BUCKETS.map(() => Decimal.ZERO), total: Decimal.ZERO, items: [] };
    c.items.push(item);
    c.buckets[item.bucket] = c.buckets[item.bucket]!.add(item.openBase);
    c.total = c.total.add(item.openBase);
    byContact.set(r.contact_id, c);
  }
  const contacts = [...byContact.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const c of contacts) c.items.sort((a, b) => a.date.localeCompare(b.date) || (a.number ?? "").localeCompare(b.number ?? ""));
  const buckets = BUCKETS.map((_, i) => Decimal.sum(contacts.map((c) => c.buckets[i]!)));
  const total = Decimal.sum(contacts.map((c) => c.total));
  const controlBalance = Decimal.from(ctl.rows[0]?.s ?? "0").mul(sign);
  const contactPath = opts.side === "receivables" ? "/sales/customers" : "/purchases/vendors";
  const rows: ReportRow[] = [];
  for (const c of contacts) {
    rows.push({
      kind: opts.detail ? "subtotal" : "detail",
      cells: [{ value: c.name, href: `${contactPath}/${c.contactId}` }, { value: null }, { value: null }, ...c.buckets.map((b) => ({ value: b.toString() })), { value: c.total.toString() }],
    });
    if (opts.detail) {
      for (const it of c.items) {
        const cells = BUCKETS.map((_, i) => ({ value: i === it.bucket ? it.openBase.toString() : null }));
        rows.push({
          kind: "detail",
          level: 1,
          cells: [
            { value: `${it.kind} ${it.number ?? ""}`.trim(), href: it.type === "document" ? `/documents/${it.id}` : `/payments/${it.id}` },
            { value: it.dueDate ?? it.date },
            { value: it.currency === org.baseCurrency ? null : `${it.openTxn.toString()} ${it.currency}` },
            ...cells,
            { value: it.openBase.toString() },
          ],
        });
      }
    }
  }
  rows.push({ kind: "total", cells: [{ value: "Total" }, { value: null }, { value: null }, ...buckets.map((b) => ({ value: b.toString() })), { value: total.toString() }] });
  const warnings = total.eq(controlBalance) ? [] : [`The aging total differs from the ${control} control account balance (${controlBalance.toString()}) by ${total.sub(controlBalance).toString()}.`];
  return {
    side: opts.side,
    asOf: opts.asOf,
    contacts,
    buckets,
    total,
    controlBalance,
    table: {
      key: opts.side === "receivables" ? "ar-aging" : "ap-aging",
      title: opts.side === "receivables" ? "Accounts receivable aging" : "Accounts payable aging",
      subtitle: `As of ${formatDate(opts.asOf)} · by days past due`,
      currency: org.baseCurrency,
      columns: [
        { key: "name", label: opts.side === "receivables" ? "Customer" : "Vendor", kind: "text" },
        { key: "due", label: "Due", kind: "date" },
        { key: "original", label: "Original currency", kind: "text" },
        ...BUCKETS.map((b, i) => ({ key: `b${i}`, label: b, kind: "money" as const, align: "right" as const })),
        { key: "total", label: "Total", kind: "money", align: "right" },
      ],
      rows,
      notes: [
        `Open items as of the date, in ${org.baseCurrency} at their carried rates. Unapplied payments and credits are shown as negative amounts in the current column. The total equals the ${opts.side === "receivables" ? "accounts receivable" : "accounts payable"} balance in the ledger on that date.`,
      ],
      ...(warnings.length ? { warnings } : {}),
    },
  };
}

export interface ContactBalance {
  contactId: string;
  name: string;
  balance: Decimal;
  deposits: Decimal;
}

/** Customer or vendor balances: what is owed, and deposits or prepayments held, per contact. */
export async function contactBalances(db: DbOrTx, org: Org, opts: { side: AgingSide; asOf: string }): Promise<{ rows: ContactBalance[]; total: Decimal; deposits: Decimal; table: ReportTable }> {
  const controls = opts.side === "receivables" ? ["receivables", "customer_deposits"] : ["payables", "vendor_prepayments"];
  const sign = opts.side === "receivables" ? Decimal.ONE : Decimal.from(-1);
  const res = await db.execute<{ contact_id: string; name: string; control: string; base: string }>(sql`
    select l.contact_id, c.display_name as name, a.control, sum(l.base_amount)::text as base
    from journal_lines l
    join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
    join accounts a on a.org_id = l.org_id and a.id = l.account_id
    join contacts c on c.org_id = l.org_id and c.id = l.contact_id
    where l.org_id = ${org.id} and e.status = 'posted' and e.entry_date <= ${opts.asOf}
      and a.control in (${sql.join(controls.map((c) => sql`${c}`), sql`, `)})
    group by l.contact_id, c.display_name, a.control
  `);
  const map = new Map<string, ContactBalance>();
  for (const r of res.rows) {
    const cb = map.get(r.contact_id) ?? { contactId: r.contact_id, name: r.name, balance: Decimal.ZERO, deposits: Decimal.ZERO };
    if (r.control === controls[0]) cb.balance = cb.balance.add(Decimal.from(r.base).mul(sign));
    else cb.deposits = cb.deposits.add(Decimal.from(r.base).mul(sign).neg());
    map.set(r.contact_id, cb);
  }
  const rows = [...map.values()].filter((r) => !r.balance.isZero() || !r.deposits.isZero()).sort((a, b) => a.name.localeCompare(b.name));
  const total = Decimal.sum(rows.map((r) => r.balance));
  const deposits = Decimal.sum(rows.map((r) => r.deposits));
  const contactPath = opts.side === "receivables" ? "/sales/customers" : "/purchases/vendors";
  const depositLabel = opts.side === "receivables" ? "Deposits held" : "Prepayments made";
  return {
    rows,
    total,
    deposits,
    table: {
      key: opts.side === "receivables" ? "customer-balances" : "vendor-balances",
      title: opts.side === "receivables" ? "Customer balances" : "Vendor balances",
      subtitle: `As of ${formatDate(opts.asOf)}`,
      currency: org.baseCurrency,
      columns: [
        { key: "name", label: opts.side === "receivables" ? "Customer" : "Vendor", kind: "text" },
        { key: "balance", label: opts.side === "receivables" ? "Balance owed to us" : "Balance we owe", kind: "money", align: "right" },
        { key: "deposits", label: depositLabel, kind: "money", align: "right" },
      ],
      rows: [
        ...rows.map((r) => ({ kind: "detail" as const, cells: [{ value: r.name, href: `${contactPath}/${r.contactId}` }, { value: r.balance.toString() }, { value: r.deposits.toString() }] })),
        { kind: "total", cells: [{ value: "Total" }, { value: total.toString() }, { value: deposits.toString() }] },
      ],
      notes: [`${depositLabel} are held on their own account and are not part of the ${opts.side} balance.`],
    },
  };
}
