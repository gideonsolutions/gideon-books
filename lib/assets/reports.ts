/**
 * Fixed-asset reports: the rollforward of cost and accumulated depreciation
 * for a period, reconciled to the ledger's asset and accumulated
 * depreciation accounts. Every movement is dated by its ledger entry, so the
 * register and the ledger use the same date boundaries.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import { accounts } from "@/lib/db/schema/ledger";
import { fixedAssets } from "@/lib/db/schema/assets";
import { Decimal } from "@/lib/money/decimal";
import { minorUnits } from "@/lib/money/currency";

export interface RollforwardRow {
  assetId: string;
  number: string;
  name: string;
  category: string | null;
  status: string;
  assetAccountId: string;
  accumulatedAccountId: string;
  openingCost: Decimal;
  additions: Decimal;
  disposals: Decimal;
  closingCost: Decimal;
  openingAccumulated: Decimal;
  depreciation: Decimal;
  acquiredAccumulated: Decimal;
  disposalsAccumulated: Decimal;
  closingAccumulated: Decimal;
  closingNbv: Decimal;
}

export interface LedgerTie {
  accountId: string;
  code: string;
  name: string;
  kind: "cost" | "accumulated_depreciation";
  register: Decimal;
  ledger: Decimal;
  difference: Decimal;
}

interface Event {
  assetId: string;
  date: string;
  cost: Decimal;
  accumulated: Decimal;
  kind: "acquisition" | "depreciation" | "disposal";
}

async function events(db: DbOrTx, orgId: string): Promise<Event[]> {
  const out: Event[] = [];
  const assets = await db.select().from(fixedAssets).where(eq(fixedAssets.orgId, orgId));
  for (const a of assets) {
    if (a.status === "draft" || !a.capitalizedOn) continue;
    out.push({ assetId: a.id, date: a.capitalizedOn, cost: Decimal.from(a.cost), accumulated: Decimal.from(a.openingAccumulatedDepreciation), kind: "acquisition" });
  }
  const dep = await db.execute<{ asset_id: string; posted_on: string | null; reversed_on: string | null; amount: string }>(sql`
    select l.asset_id, pe.entry_date as posted_on, re.entry_date as reversed_on, l.amount::text as amount
    from depreciation_run_lines l
    join depreciation_runs r on r.org_id = l.org_id and r.id = l.run_id
    left join journal_entries pe on pe.org_id = r.org_id and pe.id = r.journal_entry_id
    left join journal_entries re on re.org_id = r.org_id and re.id = r.reversal_entry_id
    where l.org_id = ${orgId} and l.status in ('posted','reversed')
  `);
  for (const r of dep.rows) {
    if (r.posted_on) out.push({ assetId: r.asset_id, date: r.posted_on, cost: Decimal.ZERO, accumulated: Decimal.from(r.amount), kind: "depreciation" });
    if (r.reversed_on) out.push({ assetId: r.asset_id, date: r.reversed_on, cost: Decimal.ZERO, accumulated: Decimal.from(r.amount).neg(), kind: "depreciation" });
  }
  const disp = await db.execute<{ asset_id: string; posted_on: string | null; reversed_on: string | null; cost: string; acc: string }>(sql`
    select d.asset_id, pe.entry_date as posted_on, re.entry_date as reversed_on, d.cost_removed::text as cost, d.accumulated_removed::text as acc
    from asset_disposals d
    left join journal_entries pe on pe.org_id = d.org_id and pe.id = d.journal_entry_id
    left join journal_entries re on re.org_id = d.org_id and re.id = d.reversal_entry_id
    where d.org_id = ${orgId}
  `);
  for (const r of disp.rows) {
    if (r.posted_on) out.push({ assetId: r.asset_id, date: r.posted_on, cost: Decimal.from(r.cost).neg(), accumulated: Decimal.from(r.acc).neg(), kind: "disposal" });
    if (r.reversed_on) out.push({ assetId: r.asset_id, date: r.reversed_on, cost: Decimal.from(r.cost), accumulated: Decimal.from(r.acc), kind: "disposal" });
  }
  return out;
}

export async function assetRollforward(db: DbOrTx, orgId: string, from: string, to: string) {
  const assets = await db.select().from(fixedAssets).where(eq(fixedAssets.orgId, orgId)).orderBy(asc(fixedAssets.number));
  const evs = await events(db, orgId);
  const rows: RollforwardRow[] = [];
  for (const a of assets) {
    if (a.status === "draft") continue;
    const mine = evs.filter((e) => e.assetId === a.id);
    const before = mine.filter((e) => e.date < from);
    const within = mine.filter((e) => e.date >= from && e.date <= to);
    const sum = (list: Event[], f: (e: Event) => Decimal) => Decimal.sum(list.map(f));
    const openingCost = sum(before, (e) => e.cost);
    const additions = sum(within.filter((e) => e.kind === "acquisition"), (e) => e.cost);
    const disposals = sum(within.filter((e) => e.kind === "disposal"), (e) => e.cost).neg();
    const openingAccumulated = sum(before, (e) => e.accumulated);
    const depreciation = sum(within.filter((e) => e.kind === "depreciation"), (e) => e.accumulated);
    const acquiredAccumulated = sum(within.filter((e) => e.kind === "acquisition"), (e) => e.accumulated);
    const disposalsAccumulated = sum(within.filter((e) => e.kind === "disposal"), (e) => e.accumulated).neg();
    const closingCost = openingCost.add(additions).sub(disposals);
    const closingAccumulated = openingAccumulated.add(depreciation).add(acquiredAccumulated).sub(disposalsAccumulated);
    if (openingCost.isZero() && closingCost.isZero() && within.length === 0) continue;
    rows.push({
      assetId: a.id,
      number: a.number,
      name: a.name,
      category: a.category,
      status: a.status,
      assetAccountId: a.assetAccountId,
      accumulatedAccountId: a.accumulatedDepreciationAccountId,
      openingCost,
      additions,
      disposals,
      closingCost,
      openingAccumulated,
      depreciation,
      acquiredAccumulated,
      disposalsAccumulated,
      closingAccumulated,
      closingNbv: closingCost.sub(closingAccumulated),
    });
  }
  const totals = {
    openingCost: Decimal.sum(rows.map((r) => r.openingCost)),
    additions: Decimal.sum(rows.map((r) => r.additions)),
    disposals: Decimal.sum(rows.map((r) => r.disposals)),
    closingCost: Decimal.sum(rows.map((r) => r.closingCost)),
    openingAccumulated: Decimal.sum(rows.map((r) => r.openingAccumulated)),
    depreciation: Decimal.sum(rows.map((r) => r.depreciation)),
    acquiredAccumulated: Decimal.sum(rows.map((r) => r.acquiredAccumulated)),
    disposalsAccumulated: Decimal.sum(rows.map((r) => r.disposalsAccumulated)),
    closingAccumulated: Decimal.sum(rows.map((r) => r.closingAccumulated)),
    closingNbv: Decimal.sum(rows.map((r) => r.closingNbv)),
  };

  // Reconcile to the ledger at the period end: every fixed-asset and
  // accumulated-depreciation account, plus any account an asset uses.
  const usedIds = new Set<string>();
  for (const a of assets) {
    usedIds.add(a.assetAccountId);
    usedIds.add(a.accumulatedDepreciationAccountId);
  }
  const accRows = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.orgId, orgId), sql`(${accounts.subtype} in ('fixed_asset','accumulated_depreciation')${usedIds.size ? sql` or ${inArray(accounts.id, [...usedIds])}` : sql``})`));
  const bal = await db.execute<{ account_id: string; b: string }>(sql`
    select l.account_id, sum(l.base_amount)::text as b
    from journal_lines l join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
    where l.org_id = ${orgId} and e.status = 'posted' and e.entry_date <= ${to}
    group by l.account_id
  `);
  const ledgerBal = new Map(bal.rows.map((r) => [r.account_id, Decimal.from(r.b)]));
  const ties: LedgerTie[] = [];
  for (const acc of accRows) {
    const isAccum = acc.subtype === "accumulated_depreciation" || assets.some((a) => a.accumulatedDepreciationAccountId === acc.id);
    const register = isAccum
      ? Decimal.sum(rows.filter((r) => r.accumulatedAccountId === acc.id).map((r) => r.closingAccumulated))
      : Decimal.sum(rows.filter((r) => r.assetAccountId === acc.id).map((r) => r.closingCost));
    // Accumulated depreciation carries a credit balance; compare as a positive figure.
    const ledger = isAccum ? (ledgerBal.get(acc.id) ?? Decimal.ZERO).neg() : (ledgerBal.get(acc.id) ?? Decimal.ZERO);
    if (register.isZero() && ledger.isZero()) continue;
    ties.push({ accountId: acc.id, code: acc.code, name: acc.name, kind: isAccum ? "accumulated_depreciation" : "cost", register, ledger, difference: ledger.sub(register) });
  }
  return { from, to, rows, totals, ties, reconciled: ties.every((t) => t.difference.isZero()) };
}

/** CSV of the rollforward (the same figures the page shows). */
export function rollforwardCsv(r: Awaited<ReturnType<typeof assetRollforward>>, currency: string): string {
  const mu = minorUnits(currency);
  const head = ["Asset", "Name", "Category", "Opening cost", "Additions", "Disposals", "Closing cost", "Opening accumulated", "Depreciation", "Acquired accumulated", "Disposals accumulated", "Closing accumulated", "Net book value"];
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const num = (d: Decimal) => d.round(mu, "half_up").toFixed(mu);
  const lines = [head.join(",")];
  for (const x of r.rows) {
    lines.push(
      [x.number, x.name, x.category ?? "", num(x.openingCost), num(x.additions), num(x.disposals), num(x.closingCost), num(x.openingAccumulated), num(x.depreciation), num(x.acquiredAccumulated), num(x.disposalsAccumulated), num(x.closingAccumulated), num(x.closingNbv)]
        .map(esc)
        .join(","),
    );
  }
  const t = r.totals;
  lines.push(["Total", "", "", num(t.openingCost), num(t.additions), num(t.disposals), num(t.closingCost), num(t.openingAccumulated), num(t.depreciation), num(t.acquiredAccumulated), num(t.disposalsAccumulated), num(t.closingAccumulated), num(t.closingNbv)].join(","));
  lines.push("");
  lines.push(["Account", "Kind", "Register", "Ledger", "Difference"].join(","));
  for (const tie of r.ties) lines.push([esc(`${tie.code} ${tie.name}`), tie.kind, num(tie.register), num(tie.ledger), num(tie.difference)].join(","));
  return lines.join("\n") + "\n";
}
