/**
 * Comparing two databases after a restore: row counts for every table, and
 * each organization's trial balance (posted lines summed per account). A
 * restore is verified only when both match exactly.
 */
import pg from "pg";
import { Decimal } from "@/lib/money/decimal";

export interface Snapshot {
  tables: Record<string, number>;
  /** orgId → accountId → balance (posted lines, all dates). */
  trialBalances: Record<string, Record<string, string>>;
  /** orgId → sum of all posted lines (zero for a sound ledger). */
  ledgerTotals: Record<string, string>;
}

export async function snapshot(connectionString: string): Promise<Snapshot> {
  const c = new pg.Client({ connectionString });
  await c.connect();
  try {
    const tables = await c.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`,
    );
    const counts: Record<string, number> = {};
    for (const t of tables.rows) {
      const r = await c.query<{ n: string }>(`select count(*)::text as n from "${t.table_name}"`);
      counts[t.table_name] = Number(r.rows[0]!.n);
    }
    const tb: Record<string, Record<string, string>> = {};
    const totals: Record<string, string> = {};
    if (counts.journal_lines !== undefined) {
      const r = await c.query<{ org_id: string; account_id: string; b: string }>(
        `select l.org_id, l.account_id, sum(l.base_amount)::text as b
           from journal_lines l join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
          where e.status = 'posted' group by l.org_id, l.account_id order by 1, 2`,
      );
      for (const row of r.rows) {
        (tb[row.org_id] ??= {})[row.account_id] = Decimal.from(row.b).normalize().toString();
        totals[row.org_id] = Decimal.from(totals[row.org_id] ?? "0").add(row.b).normalize().toString();
      }
    }
    return { tables: counts, trialBalances: tb, ledgerTotals: totals };
  } finally {
    await c.end();
  }
}

export function compareSnapshots(source: Snapshot, restored: Snapshot): string[] {
  const diffs: string[] = [];
  for (const [t, n] of Object.entries(source.tables)) {
    if (restored.tables[t] === undefined) diffs.push(`table ${t} is missing from the restore`);
    else if (restored.tables[t] !== n) diffs.push(`table ${t}: ${n} rows in the source, ${restored.tables[t]} restored`);
  }
  for (const t of Object.keys(restored.tables)) if (source.tables[t] === undefined) diffs.push(`table ${t} exists only in the restore`);
  const orgs = new Set([...Object.keys(source.trialBalances), ...Object.keys(restored.trialBalances)]);
  for (const o of orgs) {
    const a = source.trialBalances[o] ?? {};
    const b = restored.trialBalances[o] ?? {};
    for (const acc of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!Decimal.from(a[acc] ?? "0").eq(b[acc] ?? "0")) diffs.push(`organization ${o}, account ${acc}: ${a[acc] ?? "0"} in the source, ${b[acc] ?? "0"} restored`);
    }
  }
  for (const [o, total] of Object.entries(restored.ledgerTotals)) {
    if (!Decimal.from(total).isZero()) diffs.push(`organization ${o}: restored ledger does not balance (${total})`);
  }
  return diffs;
}
