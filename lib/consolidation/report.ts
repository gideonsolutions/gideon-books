/**
 * Consolidated statements for an entity group over a calendar date range
 * (docs/consolidation.md has the method in full).
 *
 *  1. Each member's posted ledger (accrual basis), in its base currency:
 *     balance-sheet accounts as of the end date; income and expense for the
 *     range; income and expense before the range rolled into the group's
 *     prior-period retained earnings.
 *  2. Mapped to group accounts. A member account with a balance and no
 *     mapping is a blocker; its amount is shown on an "Unmapped" line so the
 *     statements still foot, and the report is marked incomplete.
 *  3. Translated to the reporting currency (current-rate method, simplified):
 *     income and expense at the average rate for the range; assets,
 *     liabilities and equity (including prior-period earnings) at the closing
 *     rate. Each translated amount is rounded half-up to the reporting
 *     currency's minor units. What remains — the difference between average
 *     and closing rates on the period's income, plus rounding — is the
 *     member's cumulative translation adjustment, an equity line.
 *  4. Eliminations (group-level, reporting currency) are added: balance-sheet
 *     lines dated on or before the end date; income and expense lines dated
 *     within the range (earlier ones fall into prior-period earnings).
 *
 * Members with different fiscal years are consolidated by calendar date
 * range; the report lists each member's fiscal year and warns.
 */
import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import { eliminationEntries, eliminationLines, groupAccountMappings, groupAccounts, groupRates, intercompanyPairs } from "@/lib/db/schema/consolidation";
import { exchangeRates } from "@/lib/db/schema/ledger";
import { Decimal } from "@/lib/money/decimal";
import { minorUnits } from "@/lib/money/currency";
import { addDays, assertIsoDate, daysBetween } from "@/lib/dates";
import type { GroupAccount, GroupContext } from "./groups";

type AccountType = "asset" | "liability" | "equity" | "income" | "expense";

export interface MemberAccountBalance {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  /** Balance sheet: as of the end date. Income/expense: for the range. */
  amount: Decimal;
  /** Income/expense before the range (rolled to prior-period earnings). */
  prior: Decimal;
}

export async function memberBalances(db: DbOrTx, orgId: string, from: string, to: string): Promise<MemberAccountBalance[]> {
  const res = await db.execute<{ account_id: string; code: string; name: string; type: AccountType; period: string; upto: string; prior: string }>(sql`
    select a.id as account_id, a.code, a.name, a.type,
      coalesce(sum(l.base_amount) filter (where e.entry_date >= ${from} and e.entry_date <= ${to}), 0)::text as period,
      coalesce(sum(l.base_amount) filter (where e.entry_date <= ${to}), 0)::text as upto,
      coalesce(sum(l.base_amount) filter (where e.entry_date < ${from}), 0)::text as prior
    from journal_lines l
    join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
    join accounts a on a.org_id = l.org_id and a.id = l.account_id
    where l.org_id = ${orgId} and e.status = 'posted' and e.entry_date <= ${to}
    group by a.id, a.code, a.name, a.type
  `);
  return res.rows.map((r) => {
    const pl = r.type === "income" || r.type === "expense";
    return {
      accountId: r.account_id,
      code: r.code,
      name: r.name,
      type: r.type,
      amount: Decimal.from(pl ? r.period : r.upto),
      prior: pl ? Decimal.from(r.prior) : Decimal.ZERO,
    };
  });
}

export interface RateUsed {
  rate: Decimal;
  source: string;
  /** For a closing rate: its date. For an average: the range and number of rates averaged. */
  date?: string;
  count?: number;
  stale?: boolean;
}

/**
 * Reporting-currency units per one unit of `currency`, closing on `to` and
 * averaged over [from, to]. Sources in order: the group's own rates; rates
 * kept by a member whose base currency is the reporting currency; the
 * member's own rates for the reporting currency, inverted.
 */
export async function translationRates(
  db: DbOrTx,
  g: GroupContext,
  memberOrgId: string,
  currency: string,
  from: string,
  to: string,
): Promise<{ closing: RateUsed | null; average: RateUsed | null }> {
  const reporting = g.group.reportingCurrency;
  if (currency === reporting) return { closing: { rate: Decimal.ONE, source: "same currency" }, average: { rate: Decimal.ONE, source: "same currency" } };

  type Series = { date: string; rate: Decimal }[];
  const sources: { label: string; load: (lo: string, hi: string) => Promise<Series> }[] = [
    {
      label: "group rate",
      load: async (lo, hi) =>
        (
          await db
            .select()
            .from(groupRates)
            .where(and(eq(groupRates.groupId, g.group.id), eq(groupRates.currency, currency), gte(groupRates.rateDate, lo), lte(groupRates.rateDate, hi)))
            .orderBy(asc(groupRates.rateDate))
        ).map((r) => ({ date: r.rateDate, rate: Decimal.from(r.rate) })),
    },
    ...g.members
      .filter((m) => m.org.baseCurrency === reporting)
      .map((m) => ({
        label: `${m.org.name} exchange rates`,
        load: async (lo: string, hi: string) =>
          (
            await db
              .select()
              .from(exchangeRates)
              .where(
                and(
                  eq(exchangeRates.orgId, m.org.id),
                  eq(exchangeRates.currency, currency),
                  eq(exchangeRates.baseCurrency, reporting),
                  gte(exchangeRates.rateDate, lo),
                  lte(exchangeRates.rateDate, hi),
                  sql`${exchangeRates.source} <> 'transaction'`,
                ),
              )
              .orderBy(asc(exchangeRates.rateDate))
          ).map((r) => ({ date: r.rateDate, rate: Decimal.from(r.rate) })),
      })),
    {
      label: "member's own rates (inverted)",
      load: async (lo, hi) =>
        (
          await db
            .select()
            .from(exchangeRates)
            .where(
              and(
                eq(exchangeRates.orgId, memberOrgId),
                eq(exchangeRates.currency, reporting),
                eq(exchangeRates.baseCurrency, currency),
                gte(exchangeRates.rateDate, lo),
                lte(exchangeRates.rateDate, hi),
                sql`${exchangeRates.source} <> 'transaction'`,
              ),
            )
            .orderBy(asc(exchangeRates.rateDate))
        ).map((r) => ({ date: r.rateDate, rate: Decimal.ONE.div(r.rate, 12, "half_up") })),
    },
  ];

  let closing: RateUsed | null = null;
  for (const s of sources) {
    const series = await s.load(addDays(to, -31), to);
    const last = series[series.length - 1];
    if (last) {
      // Several rows on the same date (different sources in one table) average to one figure.
      const same = series.filter((x) => x.date === last.date);
      const rate = same.length === 1 ? last.rate : Decimal.sum(same.map((x) => x.rate)).div(same.length, 12, "half_up");
      closing = { rate, source: s.label, date: last.date, stale: daysBetween(last.date, to) > 7 };
      break;
    }
  }
  let average: RateUsed | null = null;
  for (const s of sources) {
    const series = await s.load(from, to);
    if (series.length) {
      average = { rate: Decimal.sum(series.map((x) => x.rate)).div(series.length, 12, "half_up"), source: s.label, count: series.length, date: `${from}..${to}` };
      break;
    }
  }
  if (!average && closing) average = { ...closing, source: `${closing.source} (closing rate; no rates within the range)` };
  return { closing, average };
}

export interface ConsolidatedRow {
  groupAccount: Pick<GroupAccount, "id" | "code" | "name" | "type" | "role"> | { id: "unmapped"; code: "—"; name: string; type: AccountType; role: null };
  perMember: Record<string, string>;
  eliminations: string;
  total: string;
}

export interface ConsolidationReport {
  from: string;
  to: string;
  reportingCurrency: string;
  members: {
    orgId: string;
    slug: string;
    name: string;
    currency: string;
    fiscalYearStartMonth: number;
    ownership: string;
    closing: RateUsed | null;
    average: RateUsed | null;
    cta: string;
  }[];
  rows: ConsolidatedRow[];
  blockers: { orgId: string; accountId: string; code: string; name: string; amount: string; currency: string }[];
  warnings: string[];
  /** The consolidated trial balance foots to zero (always, by construction; a non-zero total is a defect). */
  balanced: boolean;
  totals: { assets: string; liabilities: string; equity: string; income: string; expense: string; netIncome: string };
}

const ZERO = Decimal.ZERO;

export async function consolidate(db: DbOrTx, g: GroupContext, from: string, to: string): Promise<ConsolidationReport> {
  assertIsoDate(from, "from date");
  assertIsoDate(to, "to date");
  if (to < from) throw new RangeError("the range ends before it starts");
  const rc = g.group.reportingCurrency;
  const mu = minorUnits(rc);
  const accountsList = await db.select().from(groupAccounts).where(eq(groupAccounts.groupId, g.group.id)).orderBy(asc(groupAccounts.code));
  const byId = new Map(accountsList.map((a) => [a.id, a]));
  const re = accountsList.find((a) => a.role === "retained_earnings")!;
  const cta = accountsList.find((a) => a.role === "cta")!;
  const mappings = await db.select().from(groupAccountMappings).where(eq(groupAccountMappings.groupId, g.group.id));
  const mapOf = new Map(mappings.map((m) => [m.accountId, m.groupAccountId]));

  const cells = new Map<string, Map<string, Decimal>>(); // groupAccountId → orgId → amount
  const add = (gaId: string, orgId: string, v: Decimal) => {
    if (v.isZero()) return;
    let m = cells.get(gaId);
    if (!m) cells.set(gaId, (m = new Map()));
    m.set(orgId, (m.get(orgId) ?? ZERO).add(v));
  };
  const unmappedByType = new Map<AccountType, Map<string, Decimal>>();
  const report: ConsolidationReport = {
    from,
    to,
    reportingCurrency: rc,
    members: [],
    rows: [],
    blockers: [],
    warnings: [],
    balanced: true,
    totals: { assets: "0", liabilities: "0", equity: "0", income: "0", expense: "0", netIncome: "0" },
  };

  const fyMonths = new Set(g.members.map((m) => m.org.fiscalYearStartMonth));
  if (fyMonths.size > 1) {
    report.warnings.push(
      `Members have different fiscal years (${g.members.map((m) => `${m.org.name}: starts month ${m.org.fiscalYearStartMonth}`).join("; ")}). The consolidation covers the calendar range ${from} to ${to} for every member, not each member's fiscal period.`,
    );
  }

  for (const m of g.members) {
    const currency = m.org.baseCurrency;
    const rates = await translationRates(db, g, m.org.id, currency, from, to);
    if (!rates.closing || !rates.average) {
      report.warnings.push(`No ${currency}→${rc} rate for ${m.org.name} on or within 31 days before ${to}. Enter a group rate; its figures are left out until then.`);
      report.members.push({ orgId: m.org.id, slug: m.org.slug, name: m.org.name, currency, fiscalYearStartMonth: m.org.fiscalYearStartMonth, ownership: m.ownership, closing: rates.closing, average: rates.average, cta: "0" });
      continue;
    }
    if (rates.closing.stale) report.warnings.push(`The closing rate for ${m.org.name} (${currency}) is from ${rates.closing.date}, more than a week before ${to}.`);
    const balances = await memberBalances(db, m.org.id, from, to);
    let memberSum = ZERO;
    const tr = (v: Decimal, pl: boolean) => v.mul(pl ? rates.average!.rate : rates.closing!.rate).round(mu, "half_up");
    for (const b of balances) {
      const pl = b.type === "income" || b.type === "expense";
      const gaId = mapOf.get(b.accountId);
      if (!b.amount.isZero()) {
        const t = tr(b.amount, pl);
        memberSum = memberSum.add(t);
        if (gaId) add(gaId, m.org.id, t);
        else {
          report.blockers.push({ orgId: m.org.id, accountId: b.accountId, code: b.code, name: b.name, amount: b.amount.toString(), currency });
          let u = unmappedByType.get(b.type);
          if (!u) unmappedByType.set(b.type, (u = new Map()));
          u.set(m.org.id, (u.get(m.org.id) ?? ZERO).add(t));
        }
      }
      if (!b.prior.isZero()) {
        const t = tr(b.prior, false);
        memberSum = memberSum.add(t);
        add(re.id, m.org.id, t);
      }
    }
    // Whatever does not foot after translation is this member's translation adjustment.
    const adj = memberSum.neg();
    add(cta.id, m.org.id, adj);
    report.members.push({ orgId: m.org.id, slug: m.org.slug, name: m.org.name, currency, fiscalYearStartMonth: m.org.fiscalYearStartMonth, ownership: m.ownership, closing: rates.closing, average: rates.average, cta: adj.toString() });
  }

  // Eliminations.
  const elims = await db
    .select({ line: eliminationLines, entry: eliminationEntries })
    .from(eliminationLines)
    .innerJoin(eliminationEntries, and(eq(eliminationEntries.groupId, eliminationLines.groupId), eq(eliminationEntries.id, eliminationLines.entryId)))
    .where(and(eq(eliminationLines.groupId, g.group.id), eq(eliminationEntries.status, "active"), lte(eliminationEntries.entryDate, to)));
  const elimByAccount = new Map<string, Decimal>();
  for (const { line, entry } of elims) {
    const ga = byId.get(line.groupAccountId);
    if (!ga) continue;
    const pl = ga.type === "income" || ga.type === "expense";
    const target = pl && entry.entryDate < from ? re.id : ga.id;
    elimByAccount.set(target, (elimByAccount.get(target) ?? ZERO).add(Decimal.from(line.amount).round(mu, "half_up")));
  }

  let grand = ZERO;
  const totals = { asset: ZERO, liability: ZERO, equity: ZERO, income: ZERO, expense: ZERO };
  for (const ga of accountsList) {
    const per = cells.get(ga.id);
    const el = (elimByAccount.get(ga.id) ?? ZERO).rescale(mu);
    if (!per && el.isZero()) continue;
    const perMember: Record<string, string> = {};
    let total = el;
    for (const m of g.members) {
      const v = (per?.get(m.org.id) ?? ZERO).rescale(mu);
      perMember[m.org.id] = v.toString();
      total = total.add(v);
    }
    report.rows.push({ groupAccount: { id: ga.id, code: ga.code, name: ga.name, type: ga.type, role: ga.role }, perMember, eliminations: el.toString(), total: total.toString() });
    grand = grand.add(total);
    totals[ga.type] = totals[ga.type].add(total);
  }
  for (const [type, per] of unmappedByType) {
    const perMember: Record<string, string> = {};
    let total = ZERO;
    for (const m of g.members) {
      const v = per.get(m.org.id) ?? ZERO;
      perMember[m.org.id] = v.toString();
      total = total.add(v);
    }
    report.rows.push({ groupAccount: { id: "unmapped", code: "—", name: `Unmapped ${type} balances`, type, role: null }, perMember, eliminations: "0", total: total.toString() });
    grand = grand.add(total);
    totals[type] = totals[type].add(total);
  }
  report.balanced = grand.isZero();
  if (!report.balanced) report.warnings.push(`The consolidated trial balance does not foot (off by ${grand.toString()} ${rc}). Report this: it should be impossible.`);
  if (report.blockers.length) report.warnings.push(`${report.blockers.length} member account${report.blockers.length === 1 ? " has" : "s have"} balances but no mapping; the statements are incomplete until they are mapped.`);
  report.totals = {
    assets: totals.asset.toString(),
    liabilities: totals.liability.neg().toString(),
    equity: totals.equity.neg().toString(),
    income: totals.income.neg().toString(),
    expense: totals.expense.toString(),
    netIncome: totals.income.add(totals.expense).neg().toString(),
  };
  return report;
}

export interface IntercompanyRow {
  pairId: string;
  description: string | null;
  orgA: string;
  accountA: string;
  orgB: string;
  accountB: string;
  /** Each side's balance in its member currency and translated at the closing rate. */
  balanceA: string;
  balanceB: string;
  translatedA: string;
  translatedB: string;
  /** translatedA + translatedB: zero when the pair mirrors exactly. */
  difference: string;
}

/** Intercompany pairs as of `asOf` (balance-sheet pairs) or over [from, asOf] (income/expense pairs). */
export async function intercompanyBalances(db: DbOrTx, g: GroupContext, from: string, asOf: string): Promise<IntercompanyRow[]> {
  const pairs = await db.select().from(intercompanyPairs).where(eq(intercompanyPairs.groupId, g.group.id)).orderBy(asc(intercompanyPairs.createdAt));
  const mu = minorUnits(g.group.reportingCurrency);
  const out: IntercompanyRow[] = [];
  const cache = new Map<string, MemberAccountBalance[]>();
  const bal = async (orgId: string) => {
    let b = cache.get(orgId);
    if (!b) cache.set(orgId, (b = await memberBalances(db, orgId, from, asOf)));
    return b;
  };
  for (const p of pairs) {
    const side = async (orgId: string, accountId: string) => {
      const member = g.members.find((m) => m.org.id === orgId);
      const b = (await bal(orgId)).find((x) => x.accountId === accountId);
      const amount = b?.amount ?? ZERO;
      const pl = b ? b.type === "income" || b.type === "expense" : false;
      const rates = member ? await translationRates(db, g, orgId, member.org.baseCurrency, from, asOf) : { closing: null, average: null };
      const r = pl ? rates.average : rates.closing;
      return { amount, translated: r ? amount.mul(r.rate).round(mu, "half_up") : ZERO };
    };
    const a = await side(p.orgA, p.accountA);
    const b = await side(p.orgB, p.accountB);
    out.push({
      pairId: p.id,
      description: p.description,
      orgA: p.orgA,
      accountA: p.accountA,
      orgB: p.orgB,
      accountB: p.accountB,
      balanceA: a.amount.toString(),
      balanceB: b.amount.toString(),
      translatedA: a.translated.toString(),
      translatedB: b.translated.toString(),
      difference: a.translated.add(b.translated).toString(),
    });
  }
  return out;
}

/**
 * Proposed eliminations for intercompany pairs that are not yet eliminated:
 * each removes the smaller of the two mirrored balances from both sides (so a
 * pair that mirrors exactly is removed entirely; any remainder stays visible
 * on the intercompany report for investigation).
 */
export async function suggestEliminations(db: DbOrTx, g: GroupContext, from: string, to: string) {
  const rows = await intercompanyBalances(db, g, from, to);
  const mappings = await db.select().from(groupAccountMappings).where(eq(groupAccountMappings.groupId, g.group.id));
  const mapOf = new Map(mappings.map((m) => [m.accountId, m.groupAccountId]));
  const existing = await db.select().from(eliminationEntries).where(and(eq(eliminationEntries.groupId, g.group.id), eq(eliminationEntries.status, "active"), eq(eliminationEntries.entryDate, to))).orderBy(desc(eliminationEntries.createdAt));
  const suggestions: { pairId: string; description: string; lines: { groupAccountId: string; amount: string; orgId: string }[]; remainder: string; blocked?: string }[] = [];
  for (const r of rows) {
    const a = Decimal.from(r.translatedA);
    const b = Decimal.from(r.translatedB);
    if (a.isZero() && b.isZero()) continue;
    const gaA = mapOf.get(r.accountA);
    const gaB = mapOf.get(r.accountB);
    const description = `Eliminate intercompany ${r.description ?? "balance"} at ${to}`;
    if (existing.some((e) => e.description === description)) continue;
    if (!gaA || !gaB) {
      suggestions.push({ pairId: r.pairId, description, lines: [], remainder: r.difference, blocked: "Map both accounts to group accounts first." });
      continue;
    }
    if (a.sign() === b.sign()) {
      suggestions.push({ pairId: r.pairId, description, lines: [], remainder: r.difference, blocked: "Both sides have the same sign, so they do not mirror each other; check the pair." });
      continue;
    }
    const amount = Decimal.min(a.abs(), b.abs());
    suggestions.push({
      pairId: r.pairId,
      description,
      lines: [
        { groupAccountId: gaA, amount: (a.isPositive() ? amount.neg() : amount).toString(), orgId: r.orgA },
        { groupAccountId: gaB, amount: (b.isPositive() ? amount.neg() : amount).toString(), orgId: r.orgB },
      ],
      remainder: r.difference,
    });
  }
  return suggestions;
}

/** Statement views of a consolidation. */
export function statementRows(r: ConsolidationReport, kind: "balance_sheet" | "profit_and_loss" | "trial_balance") {
  if (kind === "trial_balance") return r.rows;
  const types: AccountType[] = kind === "balance_sheet" ? ["asset", "liability", "equity"] : ["income", "expense"];
  return r.rows.filter((row) => types.includes(row.groupAccount.type));
}
