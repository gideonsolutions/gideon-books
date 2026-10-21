/** Read models for the payables pages. */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import { documents } from "@/lib/db/schema/commerce";
import { contacts } from "@/lib/db/schema/ledger";
import { Decimal } from "@/lib/money/decimal";
import { addDays } from "@/lib/dates";

export interface DueRow {
  id: string;
  kind: string;
  number: string | null;
  reference: string | null;
  vendor: string | null;
  contactId: string | null;
  issueDate: string;
  dueDate: string | null;
  currency: string;
  total: string;
  open: string;
  isReimbursement: boolean;
}

/**
 * Open bills grouped by when they fall due: overdue, due in the next 7 days,
 * due later. Amounts in each bill's own currency; totals per currency.
 */
export async function payablesDue(db: DbOrTx, orgId: string, today: string) {
  const rows = await db
    .select({
      doc: documents,
      vendor: contacts.displayName,
      open: sql<string>`(select coalesce(sum(l.txn_amount), 0)::text from journal_lines l join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id where l.org_id = ${documents.orgId} and l.open_item_id = ${documents.id} and e.status = 'posted')`,
    })
    .from(documents)
    .leftJoin(contacts, and(eq(contacts.orgId, documents.orgId), eq(contacts.id, documents.contactId)))
    .where(and(eq(documents.orgId, orgId), eq(documents.kind, "bill"), inArray(documents.status, ["issued", "partially_paid"])))
    .orderBy(asc(documents.dueDate), asc(documents.issueDate));
  const weekEnd = addDays(today, 7);
  const groups: Record<"overdue" | "week" | "later", DueRow[]> = { overdue: [], week: [], later: [] };
  const totals: Record<"overdue" | "week" | "later", Map<string, Decimal>> = { overdue: new Map(), week: new Map(), later: new Map() };
  for (const r of rows) {
    const open = Decimal.from(r.open).neg();
    if (open.isZero()) continue;
    const row: DueRow = {
      id: r.doc.id,
      kind: r.doc.kind,
      number: r.doc.number,
      reference: r.doc.reference,
      vendor: r.vendor,
      contactId: r.doc.contactId,
      issueDate: r.doc.issueDate,
      dueDate: r.doc.dueDate,
      currency: r.doc.currency,
      total: r.doc.total,
      open: open.toString(),
      isReimbursement: r.doc.isReimbursement,
    };
    const g = r.doc.dueDate && r.doc.dueDate < today ? "overdue" : r.doc.dueDate && r.doc.dueDate <= weekEnd ? "week" : "later";
    groups[g].push(row);
    totals[g].set(row.currency, (totals[g].get(row.currency) ?? Decimal.ZERO).add(open));
  }
  return {
    groups,
    totals: Object.fromEntries(Object.entries(totals).map(([k, m]) => [k, [...m.entries()].map(([currency, amount]) => ({ currency, amount: amount.toString() }))])) as Record<
      "overdue" | "week" | "later",
      { currency: string; amount: string }[]
    >,
  };
}

/** Employee expense claims (bills flagged as reimbursements), with what is still owed on each. */
export async function listReimbursements(
  db: DbOrTx,
  orgId: string,
  f: { contactId?: string; from?: string; to?: string; status?: string; page?: number; pageSize?: number } = {},
) {
  const conds = [eq(documents.orgId, orgId), eq(documents.kind, "bill"), eq(documents.isReimbursement, true)];
  if (f.contactId) conds.push(eq(documents.contactId, f.contactId));
  if (f.from) conds.push(sql`${documents.issueDate} >= ${f.from}`);
  if (f.to) conds.push(sql`${documents.issueDate} <= ${f.to}`);
  if (f.status === "open") conds.push(inArray(documents.status, ["issued", "partially_paid"]));
  else if (f.status && f.status !== "overdue") conds.push(eq(documents.status, f.status as never));
  const pageSize = Math.min(Math.max(f.pageSize ?? 50, 1), 500);
  const page = Math.max(f.page ?? 1, 1);
  const where = and(...conds);
  const [rows, [count]] = await Promise.all([
    db
      .select({
        doc: documents,
        contactName: contacts.displayName,
        openAmount: sql<string>`(select coalesce(-sum(l.txn_amount), 0)::text from journal_lines l join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id where l.org_id = ${documents.orgId} and l.open_item_id = ${documents.id} and e.status = 'posted')`,
      })
      .from(documents)
      .leftJoin(contacts, and(eq(contacts.orgId, documents.orgId), eq(contacts.id, documents.contactId)))
      .where(where)
      .orderBy(sql`${documents.issueDate} desc`)
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(documents).where(where),
  ]);
  return { rows, total: count?.n ?? 0, page, pageSize };
}
