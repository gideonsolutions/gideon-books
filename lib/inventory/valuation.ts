/**
 * Inventory valuation and its reconciliation to the ledger: the value of
 * stock on hand (from the stock ledger) against the balance of the inventory
 * control accounts, per account, as of a date.
 */
import { sql } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import { Decimal } from "@/lib/money/decimal";

export interface InventoryReconciliationRow {
  accountId: string;
  accountCode: string;
  accountName: string;
  stockValue: string;
  ledgerValue: string;
  difference: string;
}

export async function inventoryReconciliation(db: DbOrTx, orgId: string, asOf: string): Promise<{ rows: InventoryReconciliationRow[]; difference: string }> {
  const res = await db.execute<{ account_id: string; code: string; name: string; stock_value: string; ledger_value: string }>(sql`
    with stock as (
      select i.inventory_account_id as account_id, coalesce(sum(m.value), 0) as value
      from stock_moves m
      join items i on i.org_id = m.org_id and i.id = m.item_id
      where m.org_id = ${orgId} and m.move_date <= ${asOf}
      group by i.inventory_account_id
    ),
    ledger as (
      select l.account_id, coalesce(sum(l.base_amount), 0) as value
      from journal_lines l
      join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
      join accounts a on a.org_id = l.org_id and a.id = l.account_id
      where l.org_id = ${orgId} and e.status = 'posted' and e.entry_date <= ${asOf} and a.control = 'inventory'
      group by l.account_id
    )
    select a.id as account_id, a.code, a.name,
           coalesce(s.value, 0)::text as stock_value,
           coalesce(g.value, 0)::text as ledger_value
    from accounts a
    left join stock s on s.account_id = a.id
    left join ledger g on g.account_id = a.id
    where a.org_id = ${orgId} and (a.control = 'inventory' or s.account_id is not null)
    order by a.code
  `);
  let total = Decimal.ZERO;
  const rows = res.rows.map((r) => {
    const diff = Decimal.from(r.ledger_value).sub(r.stock_value);
    total = total.add(diff);
    return {
      accountId: r.account_id,
      accountCode: r.code,
      accountName: r.name,
      stockValue: r.stock_value,
      ledgerValue: r.ledger_value,
      difference: diff.toString(),
    };
  });
  return { rows, difference: total.toString() };
}
