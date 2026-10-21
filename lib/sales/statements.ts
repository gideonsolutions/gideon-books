/**
 * Customer statements: the opening balance, every charge and credit in the
 * period, the closing balance, and what is open by age. Figures come from
 * the receivables (and customer-deposit) lines tagged with the customer, in
 * the customer's currency, so a statement always agrees with the ledger.
 * Settlement and revaluation entries move nothing in the customer's currency
 * and do not appear.
 */
import { sql } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import type { Ctx } from "@/lib/context";
import { requirePermission } from "@/lib/context";
import { Decimal } from "@/lib/money/decimal";
import { daysBetween } from "@/lib/dates";
import { getContact } from "@/lib/contacts/contacts";
import { openItemsForContact, type OpenItemRow } from "@/lib/commerce/open-items";

export interface StatementLine {
  entryId: string;
  date: string;
  kind: string;
  reference: string | null;
  description: string;
  sourceType: string | null;
  sourceId: string | null;
  charge: string;
  credit: string;
  balance: string;
}

export const AGING_BUCKETS = ["Current", "1–30 days", "31–60 days", "61–90 days", "Over 90 days"] as const;

export function agingBucket(dueDate: string | null, asOf: string): number {
  if (!dueDate) return 0;
  const late = daysBetween(dueDate, asOf);
  if (late <= 0) return 0;
  if (late <= 30) return 1;
  if (late <= 60) return 2;
  if (late <= 90) return 3;
  return 4;
}

export interface Statement {
  contact: Awaited<ReturnType<typeof getContact>>;
  currency: string;
  from: string;
  to: string;
  opening: string;
  lines: StatementLine[];
  closing: string;
  totalCharges: string;
  totalCredits: string;
  open: OpenItemRow[];
  aging: string[];
}

export async function customerStatement(db: DbOrTx, ctx: Ctx, contactId: string, from: string, to: string): Promise<Statement> {
  requirePermission(ctx, "ledger.read");
  const contact = await getContact(db, ctx.orgId, contactId);
  const currency = contact.currency ?? ctx.org.baseCurrency;
  const base = sql`
    from journal_lines l
    join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
    join accounts a on a.org_id = l.org_id and a.id = l.account_id
    where l.org_id = ${ctx.orgId} and l.contact_id = ${contactId} and e.status = 'posted'
      and a.control in ('receivables', 'customer_deposits') and l.currency = ${currency}`;
  const opening = await db.execute<{ s: string }>(sql`select coalesce(sum(l.txn_amount), 0)::text as s ${base} and e.entry_date < ${from}`);
  const rows = await db.execute<{ entry_id: string; entry_date: string; kind: string; source_ref: string | null; description: string; source_type: string | null; source_id: string | null; amount: string; entry_number: number }>(sql`
    select e.id as entry_id, e.entry_date, e.kind, e.source_ref, e.description, e.source_type, e.source_id, e.entry_number, sum(l.txn_amount)::text as amount
    ${base} and e.entry_date >= ${from} and e.entry_date <= ${to}
    group by e.id, e.entry_date, e.kind, e.source_ref, e.description, e.source_type, e.source_id, e.entry_number
    having sum(l.txn_amount) <> 0
    order by e.entry_date, e.entry_number`);
  let running = Decimal.from(opening.rows[0]?.s ?? "0");
  const openingBal = running;
  let charges = Decimal.ZERO;
  let credits = Decimal.ZERO;
  const lines: StatementLine[] = rows.rows.map((r) => {
    const amt = Decimal.from(r.amount);
    running = running.add(amt);
    if (amt.isPositive()) charges = charges.add(amt);
    else credits = credits.add(amt.neg());
    return {
      entryId: r.entry_id,
      date: r.entry_date,
      kind: r.kind,
      reference: r.source_ref,
      description: r.description,
      sourceType: r.source_type,
      sourceId: r.source_id,
      charge: amt.isPositive() ? amt.toString() : "0",
      credit: amt.isNegative() ? amt.neg().toString() : "0",
      balance: running.toString(),
    };
  });
  const open = (await openItemsForContact(db, ctx.orgId, "receivables", contactId, to)).filter((o) => o.currency === currency);
  const aging = AGING_BUCKETS.map(() => Decimal.ZERO);
  for (const o of open) {
    const signed = o.nature === "debit" ? Decimal.from(o.openTxn) : Decimal.from(o.openTxn).neg();
    // Credits (payments not yet applied, credit notes) count as current.
    const b = o.nature === "debit" ? agingBucket(o.dueDate, to) : 0;
    aging[b] = aging[b]!.add(signed);
  }
  return {
    contact,
    currency,
    from,
    to,
    opening: openingBal.toString(),
    lines,
    closing: running.toString(),
    totalCharges: charges.toString(),
    totalCredits: credits.toString(),
    open,
    aging: aging.map((a) => a.toString()),
  };
}
