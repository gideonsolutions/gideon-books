/**
 * The one query every report is built on: the posted ledger lines of an
 * organization on an accounting basis (docs/accounting/cash-basis.md).
 *
 *  accrual — every line of every posted entry.
 *  cash    — lines of entries posted "as is"; lines of settlement entries
 *            except those that relieve a document's receivable or payable
 *            (an open item of type "document"), replaced by the cash-basis
 *            recognition of that document (cash_basis_lines, dated the
 *            settlement); entries posted "deferred" (receivable and payable
 *            documents, revaluation of open items) are left out entirely.
 *            A settlement between two documents (a credit note, write-off or
 *            vendor credit applied to an invoice or bill) moves no cash, so on
 *            the cash basis it is left out entirely: its entry, and the
 *            recognition it would otherwise carry for either document.
 *
 * Both produce the same columns, so every report is basis-agnostic. The
 * cash set balances to zero entry by entry; tests/reports/cash-basis.test.ts
 * proves it on every scenario.
 */
import { sql, type SQL } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import { Decimal } from "@/lib/money/decimal";
import type { Basis, LineFilters } from "./scope";

/**
 * A subquery with one row per ledger line:
 * entry_id, entry_number, entry_date, kind, source_type, source_id, source_ref,
 * entry_description, is_adjusting, line_id, account_id, base_amount, currency,
 * txn_amount, contact_id, description, item_id, project_id, class_id,
 * department_id, location_id, fund_id, trust_component, beneficiary_id,
 * open_item_type, open_item_id, recognized (true for cash-basis recognition rows).
 */
export function ledgerRows(orgId: string, basis: Basis): SQL {
  const accrual = sql`
    select e.id as entry_id, e.entry_number, e.entry_date, e.kind, e.source_type, e.source_id, e.source_ref,
           e.description as entry_description, e.is_adjusting,
           l.id as line_id, l.account_id, l.base_amount, l.currency, l.txn_amount, l.contact_id,
           l.description, l.item_id, l.project_id, l.class_id, l.department_id, l.location_id, l.fund_id,
           l.trust_component, l.beneficiary_id, l.open_item_type, l.open_item_id, false as recognized
    from journal_lines l
    join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
    where l.org_id = ${orgId} and e.status = 'posted'`;
  if (basis === "accrual") return accrual;
  // Settlements where neither side is cash.
  const docToDoc = sql`(select s.id from settlements s where s.org_id = ${orgId} and s.debit_item_type = 'document' and s.credit_item_type = 'document')`;
  return sql`
    ${accrual}
      and (
        e.cash_basis = 'as_is'
        or (e.cash_basis = 'settlement' and coalesce(l.open_item_type, '') <> 'document'
            and not (e.source_type = 'settlement' and e.source_id in ${docToDoc}))
      )
    union all
    select e.id as entry_id, e.entry_number, c.entry_date, e.kind, e.source_type, e.source_id, e.source_ref,
           e.description as entry_description, e.is_adjusting,
           c.id as line_id, c.account_id, c.base_amount, c.currency, c.txn_amount, c.contact_id,
           coalesce(src.description, se.description) as description, c.item_id, c.project_id, c.class_id, c.department_id,
           c.location_id, c.fund_id, c.trust_component, c.beneficiary_id, null as open_item_type, null as open_item_id,
           true as recognized
    from cash_basis_lines c
    join journal_entries e on e.org_id = c.org_id and e.id = c.entry_id
    left join journal_lines src on src.org_id = c.org_id and src.id = c.source_line_id
    left join journal_entries se on se.org_id = c.org_id and se.id = c.source_entry_id
    where c.org_id = ${orgId} and e.status = 'posted' and c.settlement_id not in ${docToDoc}`;
}

/** WHERE conditions on a ledger-rows alias `lr` for the filters. */
export function filterSql(f: LineFilters, alias = "lr"): SQL {
  const a = sql.raw(alias);
  const parts: SQL[] = [sql`true`];
  if (f.accountIds?.length) parts.push(sql`${a}.account_id in (${sql.join(f.accountIds.map((i) => sql`${i}::uuid`), sql`, `)})`);
  if (f.contactId) parts.push(sql`${a}.contact_id = ${f.contactId}::uuid`);
  const dim = (col: string, v: string | undefined) => {
    if (!v) return;
    const c = sql.raw(`${alias}.${col}`);
    parts.push(v === "none" ? sql`${c} is null` : sql`${c} = ${v}::uuid`);
  };
  dim("project_id", f.projectId);
  dim("class_id", f.classId);
  dim("department_id", f.departmentId);
  dim("location_id", f.locationId);
  dim("fund_id", f.fundId);
  if (f.trustComponent) parts.push(sql`${a}.trust_component = ${f.trustComponent}`);
  if (f.beneficiaryId) parts.push(sql`${a}.beneficiary_id = ${f.beneficiaryId}::uuid`);
  return sql.join(parts, sql` and `);
}

export interface AccountAmount {
  accountId: string;
  base: Decimal;
  txn: Decimal;
  lines: number;
}

/**
 * Sum of base amounts per account between two dates (inclusive; either may
 * be null for open-ended), on a basis, with filters.
 */
export async function sumByAccount(
  db: DbOrTx,
  orgId: string,
  basis: Basis,
  range: { from?: string | null; to?: string | null },
  filters: LineFilters = {},
): Promise<Map<string, AccountAmount>> {
  const res = await db.execute<{ account_id: string; base: string; txn: string; n: number }>(sql`
    select lr.account_id, sum(lr.base_amount)::text as base, sum(lr.txn_amount)::text as txn, count(*)::int as n
    from (${ledgerRows(orgId, basis)}) lr
    where ${filterSql(filters)}
      ${range.from ? sql`and lr.entry_date >= ${range.from}` : sql``}
      ${range.to ? sql`and lr.entry_date <= ${range.to}` : sql``}
    group by lr.account_id
  `);
  return new Map(res.rows.map((r) => [r.account_id, { accountId: r.account_id, base: Decimal.from(r.base), txn: Decimal.from(r.txn), lines: r.n }]));
}

/** Sums per account and a dimension column (for dimension reporting). */
export async function sumByAccountAndDimension(
  db: DbOrTx,
  orgId: string,
  basis: Basis,
  range: { from: string; to: string },
  dimension: "project" | "class" | "department" | "location" | "fund",
  filters: LineFilters = {},
): Promise<{ accountId: string; dimensionId: string | null; base: Decimal }[]> {
  const col = sql.raw(`lr.${dimension}_id`);
  const res = await db.execute<{ account_id: string; dim: string | null; base: string }>(sql`
    select lr.account_id, ${col}::text as dim, sum(lr.base_amount)::text as base
    from (${ledgerRows(orgId, basis)}) lr
    where ${filterSql(filters)} and lr.entry_date >= ${range.from} and lr.entry_date <= ${range.to}
    group by lr.account_id, ${col}
  `);
  return res.rows.map((r) => ({ accountId: r.account_id, dimensionId: r.dim, base: Decimal.from(r.base) }));
}

/** The sum of every row in a scope (a whole-ledger check: zero when it balances). */
export async function ledgerTotal(db: DbOrTx, orgId: string, basis: Basis, to?: string): Promise<Decimal> {
  const res = await db.execute<{ s: string }>(sql`
    select coalesce(sum(lr.base_amount), 0)::text as s from (${ledgerRows(orgId, basis)}) lr
    ${to ? sql`where lr.entry_date <= ${to}` : sql``}
  `);
  return Decimal.from(res.rows[0]?.s ?? "0");
}

/** Entries whose rows do not balance on a basis (should always be empty). */
export async function unbalancedEntries(db: DbOrTx, orgId: string, basis: Basis): Promise<{ entryId: string; total: string }[]> {
  const res = await db.execute<{ entry_id: string; total: string }>(sql`
    select lr.entry_id, sum(lr.base_amount)::text as total
    from (${ledgerRows(orgId, basis)}) lr
    group by lr.entry_id
    having sum(lr.base_amount) <> 0
  `);
  return res.rows.map((r) => ({ entryId: r.entry_id, total: r.total }));
}
