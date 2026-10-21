/**
 * Search across an organization's records: contacts, documents (by number,
 * reference or contact), payments, items, accounts and journal entries.
 */
import { sql } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";

export type SearchHit = {
  type: "contact" | "document" | "payment" | "item" | "account" | "journal_entry";
  id: string;
  title: string;
  subtitle: string;
  kind?: string;
};

export async function searchOrg(db: DbOrTx, orgId: string, q: string, limit = 10): Promise<SearchHit[]> {
  const term = q.trim();
  if (term.length < 2) return [];
  const like = `%${term.replace(/[%_\\]/g, "\\$&")}%`;
  const num = /^#?\d+$/.test(term) ? Number(term.replace("#", "")) : null;
  const res = await db.execute<SearchHit & { rank: number }>(sql`
    (select 'contact' as type, id::text, display_name as title,
            concat_ws(' · ', case when is_customer then 'customer' end, case when is_vendor then 'vendor' end, case when is_employee then 'employee' end, email) as subtitle,
            null as kind, 1 as rank
       from contacts where org_id = ${orgId} and (display_name ilike ${like} or company_name ilike ${like} or email ilike ${like}) limit ${limit})
    union all
    (select 'document', d.id::text, concat_ws(' ', replace(d.kind, '_', ' '), coalesce(d.number, d.reference)),
            concat_ws(' · ', c.display_name, d.issue_date::text, d.total::text || ' ' || d.currency, d.status), d.kind, 2
       from documents d left join contacts c on c.org_id = d.org_id and c.id = d.contact_id
      where d.org_id = ${orgId} and (d.number ilike ${like} or d.reference ilike ${like} or c.display_name ilike ${like} or d.memo ilike ${like})
      order by d.issue_date desc limit ${limit})
    union all
    (select 'payment', p.id::text, concat_ws(' ', replace(p.kind, '_', ' '), p.number),
            concat_ws(' · ', c.display_name, p.payment_date::text, p.amount::text || ' ' || p.currency, p.reference), p.kind, 3
       from payments p left join contacts c on c.org_id = p.org_id and c.id = p.contact_id
      where p.org_id = ${orgId} and (p.number ilike ${like} or p.reference ilike ${like} or c.display_name ilike ${like})
      order by p.payment_date desc limit ${limit})
    union all
    (select 'item', id::text, name, concat_ws(' · ', sku, kind), kind, 4
       from items where org_id = ${orgId} and (name ilike ${like} or sku ilike ${like}) limit ${limit})
    union all
    (select 'account', id::text, concat(code, ' ', name), replace(subtype, '_', ' '), null, 5
       from accounts where org_id = ${orgId} and (name ilike ${like} or code ilike ${like}) limit ${limit})
    union all
    (select 'journal_entry', id::text, concat('Entry #', entry_number), concat_ws(' · ', entry_date::text, description), kind, 6
       from journal_entries where org_id = ${orgId} and status = 'posted'
        and (description ilike ${like} or source_ref ilike ${like} ${num !== null ? sql`or entry_number = ${num}` : sql``})
      order by entry_date desc limit ${limit})
  `);
  return res.rows.sort((a, b) => a.rank - b.rank).map((r) => ({ type: r.type, id: r.id, title: r.title, subtitle: r.subtitle, ...(r.kind ? { kind: r.kind } : {}) }));
}
