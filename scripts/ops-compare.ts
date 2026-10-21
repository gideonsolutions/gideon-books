/**
 * Compare two databases (row counts per table and every organization's
 * trial balance). Used by scripts/verify-restore.sh.
 *
 *   npx tsx scripts/ops-compare.ts <source-database-url> <restored-database-url>
 *   npx tsx scripts/ops-compare.ts --check <database-url>    (every ledger balances)
 * Exits 0 when they match (or the ledger balances), 1 otherwise.
 */
import { compareSnapshots, snapshot } from "../lib/ops/verify";
import { Decimal } from "../lib/money/decimal";

async function main() {
  const [a, b] = process.argv.slice(2);
  if (a === "--check" && b) {
    const s = await snapshot(b);
    const bad = Object.entries(s.ledgerTotals).filter(([, t]) => !Decimal.from(t).isZero());
    const rows = Object.values(s.tables).reduce((x, y) => x + y, 0);
    console.log(`${Object.keys(s.tables).length} tables, ${rows} rows, ${Object.keys(s.trialBalances).length} organizations with postings.`);
    if (bad.length) {
      for (const [o, t] of bad) console.error(`organization ${o}: ledger off by ${t}`);
      process.exit(1);
    }
    console.log("Every organization's ledger balances.");
    return;
  }
  if (!a || !b) {
    console.error("Usage: ops-compare.ts <source-url> <restored-url> | --check <url>");
    process.exit(2);
  }
  const [s1, s2] = await Promise.all([snapshot(a), snapshot(b)]);
  const diffs = compareSnapshots(s1, s2);
  const rows = Object.values(s1.tables).reduce((x, y) => x + y, 0);
  if (diffs.length) {
    console.error(`Restore does NOT match the source (${diffs.length} difference${diffs.length === 1 ? "" : "s"}):`);
    for (const d of diffs.slice(0, 50)) console.error(`  - ${d}`);
    process.exit(1);
  }
  console.log(`Restore verified: ${Object.keys(s1.tables).length} tables and ${rows} rows match; ${Object.keys(s1.trialBalances).length} organizations' trial balances are identical.`);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
