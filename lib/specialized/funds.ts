/**
 * Nonprofit fund reporting (docs/accounting/funds-and-trusts.md).
 *
 * Funds are the `fund` dimension; each fund carries its donor restriction.
 * Lines without a fund belong to net assets without donor restrictions. A
 * fund's net assets are everything tagged to it on equity, income and
 * expense accounts — so the funds always add up to assets minus liabilities.
 *
 * These reports support the nonprofit presentation (activities and net
 * assets by restriction class). They do not certify compliance with GAAP
 * (ASC 958) or any regulator's form.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { withTransaction, type DbOrTx } from "@/lib/db/client";
import { dimensionValues } from "@/lib/db/schema/ledger";
import { audit } from "@/lib/audit";
import { requirePermission, type Ctx } from "@/lib/context";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { Decimal } from "@/lib/money/decimal";
import { minorUnits } from "@/lib/money/currency";
import { addDays, isIsoDate } from "@/lib/dates";
import { postEntry } from "@/lib/ledger/posting";
import { systemAccountId } from "@/lib/ledger/accounts";

export type RestrictionClass = "without" | "with";
export type Restriction = "without_donor_restrictions" | "with_donor_restrictions_temporary" | "with_donor_restrictions_perpetual";

export interface FundInfo {
  id: string | null;
  name: string;
  restriction: Restriction;
  class: RestrictionClass;
}

export const NO_FUND: FundInfo = { id: null, name: "General (no fund)", restriction: "without_donor_restrictions", class: "without" };

export function classOf(r: Restriction): RestrictionClass {
  return r === "without_donor_restrictions" ? "without" : "with";
}

export async function listFunds(db: DbOrTx, orgId: string): Promise<FundInfo[]> {
  const rows = await db
    .select()
    .from(dimensionValues)
    .where(and(eq(dimensionValues.orgId, orgId), eq(dimensionValues.kind, "fund")))
    .orderBy(asc(dimensionValues.name));
  return [NO_FUND, ...rows.map((r) => ({ id: r.id, name: r.name, restriction: r.restriction!, class: classOf(r.restriction!) }))];
}

const key = (id: string | null) => id ?? "none";

export interface ActivitiesRow {
  accountId: string;
  code: string;
  name: string;
  perFund: Record<string, string>;
  without: string;
  with: string;
  total: string;
}

export interface StatementOfActivities {
  from: string;
  to: string;
  funds: FundInfo[];
  revenue: ActivitiesRow[];
  expenses: ActivitiesRow[];
  /** Net assets released from restriction: + for the receiving fund, − for the releasing fund. */
  releases: Record<string, string>;
  totals: {
    revenue: Record<string, string>;
    expenses: Record<string, string>;
    change: Record<string, string>;
    byClass: Record<RestrictionClass, { revenue: string; expenses: string; releases: string; change: string }>;
  };
}

/** Revenue and expense by fund and restriction class, with releases, for a period. */
export async function statementOfActivities(db: DbOrTx, orgId: string, from: string, to: string): Promise<StatementOfActivities> {
  const funds = await listFunds(db, orgId);
  const fundById = new Map(funds.map((f) => [key(f.id), f]));
  const res = await db.execute<{ account_id: string; code: string; name: string; type: string; fund_id: string | null; amount: string }>(sql`
    select a.id as account_id, a.code, a.name, a.type, l.fund_id, sum(l.base_amount)::text as amount
    from journal_lines l
    join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
    join accounts a on a.org_id = l.org_id and a.id = l.account_id
    where l.org_id = ${orgId} and e.status = 'posted' and e.entry_date between ${from} and ${to} and a.type in ('income','expense')
    group by a.id, a.code, a.name, a.type, l.fund_id
    order by a.code
  `);
  const rel = await db.execute<{ fund_id: string | null; amount: string }>(sql`
    select l.fund_id, sum(l.base_amount)::text as amount
    from journal_lines l
    join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
    join accounts a on a.org_id = l.org_id and a.id = l.account_id
    where l.org_id = ${orgId} and e.status = 'posted' and e.entry_date between ${from} and ${to}
      and e.source_type = 'fund_release' and a.type = 'equity'
    group by l.fund_id
  `);
  const build = (type: "income" | "expense") => {
    const rows = new Map<string, ActivitiesRow & { _per: Map<string, Decimal> }>();
    for (const r of res.rows.filter((x) => x.type === type)) {
      let row = rows.get(r.account_id);
      if (!row) rows.set(r.account_id, (row = { accountId: r.account_id, code: r.code, name: r.name, perFund: {}, without: "0", with: "0", total: "0", _per: new Map() }));
      // Revenue shown as a positive number (credits), expenses as positive (debits).
      const v = type === "income" ? Decimal.from(r.amount).neg() : Decimal.from(r.amount);
      row._per.set(key(r.fund_id), (row._per.get(key(r.fund_id)) ?? Decimal.ZERO).add(v));
    }
    return [...rows.values()].map((row) => {
      let w = Decimal.ZERO;
      let wr = Decimal.ZERO;
      for (const [k, v] of row._per) {
        row.perFund[k] = v.toString();
        if ((fundById.get(k) ?? NO_FUND).class === "without") w = w.add(v);
        else wr = wr.add(v);
      }
      const { _per, ...out } = row;
      void _per;
      return { ...out, without: w.toString(), with: wr.toString(), total: w.add(wr).toString() };
    });
  };
  const revenue = build("income");
  const expenses = build("expense");
  const releases: Record<string, string> = {};
  for (const r of rel.rows) releases[key(r.fund_id)] = Decimal.from(r.amount).neg().toString();
  const totals: StatementOfActivities["totals"] = {
    revenue: {},
    expenses: {},
    change: {},
    byClass: {
      without: { revenue: "0", expenses: "0", releases: "0", change: "0" },
      with: { revenue: "0", expenses: "0", releases: "0", change: "0" },
    },
  };
  const cls = { without: { revenue: Decimal.ZERO, expenses: Decimal.ZERO, releases: Decimal.ZERO }, with: { revenue: Decimal.ZERO, expenses: Decimal.ZERO, releases: Decimal.ZERO } };
  for (const f of funds) {
    const k = key(f.id);
    const rv = Decimal.sum(revenue.map((r) => r.perFund[k] ?? "0"));
    const ex = Decimal.sum(expenses.map((r) => r.perFund[k] ?? "0"));
    const rl = Decimal.from(releases[k] ?? "0");
    totals.revenue[k] = rv.toString();
    totals.expenses[k] = ex.toString();
    totals.change[k] = rv.sub(ex).add(rl).toString();
    cls[f.class].revenue = cls[f.class].revenue.add(rv);
    cls[f.class].expenses = cls[f.class].expenses.add(ex);
    cls[f.class].releases = cls[f.class].releases.add(rl);
  }
  for (const c of ["without", "with"] as const) {
    totals.byClass[c] = {
      revenue: cls[c].revenue.toString(),
      expenses: cls[c].expenses.toString(),
      releases: cls[c].releases.toString(),
      change: cls[c].revenue.sub(cls[c].expenses).add(cls[c].releases).toString(),
    };
  }
  return { from, to, funds, revenue, expenses, releases, totals };
}

/** Net assets of each fund as of a date: minus the sum of its equity, income and expense lines. */
export async function netAssetsByFund(db: DbOrTx, orgId: string, asOf: string): Promise<Map<string, Decimal>> {
  const res = await db.execute<{ fund_id: string | null; amount: string }>(sql`
    select l.fund_id, sum(l.base_amount)::text as amount
    from journal_lines l
    join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
    join accounts a on a.org_id = l.org_id and a.id = l.account_id
    where l.org_id = ${orgId} and e.status = 'posted' and e.entry_date <= ${asOf} and a.type in ('equity','income','expense')
    group by l.fund_id
  `);
  return new Map(res.rows.map((r) => [key(r.fund_id), Decimal.from(r.amount).neg()]));
}

export interface FinancialPositionByRestriction {
  asOf: string;
  assets: string;
  liabilities: string;
  funds: (FundInfo & { netAssets: string })[];
  byClass: Record<RestrictionClass, string>;
  totalNetAssets: string;
  /** assets − liabilities − net assets; zero unless the ledger is broken. */
  difference: string;
}

export async function financialPositionByRestriction(db: DbOrTx, orgId: string, asOf: string): Promise<FinancialPositionByRestriction> {
  const funds = await listFunds(db, orgId);
  const na = await netAssetsByFund(db, orgId, asOf);
  const [al] = (
    await db.execute<{ assets: string; liabilities: string }>(sql`
      select coalesce(sum(l.base_amount) filter (where a.type = 'asset'), 0)::text as assets,
             coalesce(sum(l.base_amount) filter (where a.type = 'liability'), 0)::text as liabilities
      from journal_lines l
      join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
      join accounts a on a.org_id = l.org_id and a.id = l.account_id
      where l.org_id = ${orgId} and e.status = 'posted' and e.entry_date <= ${asOf}
    `)
  ).rows;
  const assets = Decimal.from(al?.assets ?? "0");
  const liabilities = Decimal.from(al?.liabilities ?? "0").neg();
  const byClass = { without: Decimal.ZERO, with: Decimal.ZERO };
  const rows = funds.map((f) => {
    const v = na.get(key(f.id)) ?? Decimal.ZERO;
    byClass[f.class] = byClass[f.class].add(v);
    return { ...f, netAssets: v.toString() };
  });
  const total = byClass.without.add(byClass.with);
  return {
    asOf,
    assets: assets.toString(),
    liabilities: liabilities.toString(),
    funds: rows,
    byClass: { without: byClass.without.toString(), with: byClass.with.toString() },
    totalNetAssets: total.toString(),
    difference: assets.sub(liabilities).sub(total).toString(),
  };
}

export interface FundBalanceRow extends FundInfo {
  opening: string;
  revenue: string;
  expenses: string;
  releases: string;
  closing: string;
}

/** Opening balance, activity and closing balance of each fund for a period. */
export async function fundBalances(db: DbOrTx, orgId: string, from: string, to: string): Promise<FundBalanceRow[]> {
  const opening = await netAssetsByFund(db, orgId, addDays(from, -1));
  const closing = await netAssetsByFund(db, orgId, to);
  const act = await statementOfActivities(db, orgId, from, to);
  return act.funds.map((f) => {
    const k = key(f.id);
    return {
      ...f,
      opening: (opening.get(k) ?? Decimal.ZERO).toString(),
      revenue: act.totals.revenue[k] ?? "0",
      expenses: act.totals.expenses[k] ?? "0",
      releases: act.releases[k] ?? "0",
      closing: (closing.get(k) ?? Decimal.ZERO).toString(),
    };
  });
}

/**
 * Release net assets from a donor restriction (the purpose was met or the
 * time passed): Dr net assets with donor restrictions in the restricted fund,
 * Cr net assets without donor restrictions (in `toFundId`, or no fund).
 */
export async function releaseFromRestriction(ctx: Ctx, input: { fundId: string; toFundId?: string | null; amount: string; date: string; reason: string }) {
  requirePermission(ctx, "ledger.post");
  const fields: Record<string, string> = {};
  if (!isIsoDate(input.date)) fields.date = "Enter the date of the release.";
  const amount = Decimal.tryFrom(input.amount?.replace(/,/g, "").trim());
  if (!amount || !amount.isPositive()) fields.amount = "Enter the amount released.";
  else if (amount.decimalPlaces > minorUnits(ctx.org.baseCurrency)) fields.amount = "Too many decimal places.";
  if (!input.reason?.trim()) fields.reason = "Say what satisfied the restriction (purpose met, time elapsed).";
  if (Object.keys(fields).length) throw new ValidationError("Check the release.", fields);
  return withTransaction(async (tx) => {
    const [fund] = await tx.select().from(dimensionValues).where(and(eq(dimensionValues.orgId, ctx.orgId), eq(dimensionValues.id, input.fundId), eq(dimensionValues.kind, "fund")));
    if (!fund) throw new NotFoundError("The fund");
    if (fund.restriction === "without_donor_restrictions") throw new ValidationError(`${fund.name} carries no donor restriction; there is nothing to release.`, { fundId: "Not restricted." });
    if (fund.restriction === "with_donor_restrictions_perpetual") {
      throw new ConflictError(`${fund.name} is perpetually restricted; its corpus is not released. Release only what the donor's terms allow from its earnings fund.`, "perpetual_restriction");
    }
    if (input.toFundId) {
      const [to] = await tx.select().from(dimensionValues).where(and(eq(dimensionValues.orgId, ctx.orgId), eq(dimensionValues.id, input.toFundId), eq(dimensionValues.kind, "fund")));
      if (!to) throw new NotFoundError("The receiving fund");
      if (to.restriction !== "without_donor_restrictions") throw new ValidationError("Released net assets go to a fund without donor restrictions.", { toFundId: "Pick an unrestricted fund." });
    }
    const held = (await netAssetsByFund(tx, ctx.orgId, input.date)).get(fund.id) ?? Decimal.ZERO;
    if (amount!.gt(held)) {
      throw new ConflictError(`${fund.name} holds ${held.toString()} on ${input.date}; ${amount!.toString()} cannot be released.`, "release_exceeds_fund", { held: held.toString() });
    }
    const withAcct = await systemAccountId(tx, ctx.orgId, "net_assets_with_restrictions");
    const withoutAcct = await systemAccountId(tx, ctx.orgId, "net_assets_without_restrictions");
    const posted = await postEntry(tx, ctx, {
      kind: "manual",
      entryDate: input.date,
      description: `Release from restriction: ${fund.name} — ${input.reason.trim()}`,
      sourceType: "fund_release",
      sourceId: fund.id,
      lines: [
        { accountId: withAcct, amount: amount!.toString(), fundId: fund.id, description: "Net assets released from restriction" },
        { accountId: withoutAcct, amount: amount!.neg().toString(), fundId: input.toFundId || null, description: "Net assets released from restriction" },
      ],
    });
    await audit(tx, ctx, { action: "fund.released", entityType: "fund", entityId: fund.id, reason: input.reason.trim(), metadata: { amount: amount!.toString(), date: input.date, entryId: posted.entry.id, toFundId: input.toFundId ?? null } });
    return posted;
  });
}
