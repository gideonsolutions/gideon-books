/**
 * The accountant's practice view: every organization a person belongs to,
 * with what needs attention in each. Read-only, computed per request.
 */
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { orgsForUser } from "@/lib/orgs/orgs";
import { pgErrorCode } from "@/lib/db/client";
import type { Role } from "@/lib/db/schema/core";
import type { Org } from "@/lib/context";

export interface PracticeRow {
  org: Org;
  role: Role;
  lastActivity: Date | null;
  draftEntries: number;
  draftDocuments: number;
  overdueInvoices: number;
  periodsAwaitingClose: number;
  /** null when the banking module's tables are not present. */
  unreviewedBank: number | null;
}

export async function practiceOverview(userId: string, today = new Date().toISOString().slice(0, 10)): Promise<PracticeRow[]> {
  const db = getDb();
  const memberships = await orgsForUser(db, userId);
  if (!memberships.length) return [];
  const ids = memberships.map((m) => m.org.id);
  const list = sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `);
  const monthStart = `${today.slice(0, 7)}-01`;
  const counts = await db.execute<{ org_id: string; last: Date | null; drafts: number; draft_docs: number; overdue: number; periods: number }>(sql`
    select o.id as org_id,
      (select max(created_at) from audit_events a where a.org_id = o.id) as last,
      (select count(*)::int from journal_entries j where j.org_id = o.id and j.status = 'draft') as drafts,
      (select count(*)::int from documents d where d.org_id = o.id and d.status = 'draft') as draft_docs,
      (select count(*)::int from documents d where d.org_id = o.id and d.kind = 'invoice' and d.status in ('issued','partially_paid') and d.due_date < ${today}) as overdue,
      (select count(*)::int from fiscal_periods p where p.org_id = o.id and p.status = 'open' and p.end_date < ${monthStart}
         and exists (select 1 from journal_entries j where j.org_id = o.id and j.entry_date <= p.end_date)) as periods
    from organizations o where o.id in (${list})
  `);
  let bank = new Map<string, number>();
  let bankAvailable = true;
  try {
    const b = await db.execute<{ org_id: string; n: number }>(sql`select org_id, count(*)::int as n from bank_transactions where org_id in (${list}) and status = 'unreviewed' group by org_id`);
    bank = new Map(b.rows.map((r) => [r.org_id, r.n]));
  } catch (e) {
    if (pgErrorCode(e) !== "42P01" && pgErrorCode(e) !== "42703") throw e;
    bankAvailable = false;
  }
  const byId = new Map(counts.rows.map((r) => [r.org_id, r]));
  return memberships.map(({ org, role }) => {
    const c = byId.get(org.id);
    return {
      org,
      role,
      lastActivity: c?.last ? new Date(c.last) : null,
      draftEntries: c?.drafts ?? 0,
      draftDocuments: c?.draft_docs ?? 0,
      overdueInvoices: c?.overdue ?? 0,
      periodsAwaitingClose: c?.periods ?? 0,
      unreviewedBank: bankAvailable ? (bank.get(org.id) ?? 0) : null,
    };
  });
}
