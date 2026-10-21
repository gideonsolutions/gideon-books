/**
 * Trust and estate reporting (docs/accounting/funds-and-trusts.md).
 *
 * Every journal line may say which side of the trust it belongs to
 * (`trust_component`: principal or income) and which beneficiary it concerns.
 * These reports present what the fiduciary recorded. Gideon Books does not
 * decide whether a receipt or disbursement is principal or income under any
 * state's principal-and-income act, does not compute distributable net
 * income, and does not prepare or file Form 1041 or any state fiduciary
 * return.
 */
import { and, eq, sql } from "drizzle-orm";
import { withTransaction, type DbOrTx } from "@/lib/db/client";
import { accounts, contacts } from "@/lib/db/schema/ledger";
import { audit } from "@/lib/audit";
import { requirePermission, type Ctx } from "@/lib/context";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { Decimal } from "@/lib/money/decimal";
import { minorUnits } from "@/lib/money/currency";
import { isIsoDate } from "@/lib/dates";
import { postEntry } from "@/lib/ledger/posting";
import { systemAccountId } from "@/lib/ledger/accounts";

export type Component = "principal" | "income" | "unassigned";
const COMPONENTS: Component[] = ["principal", "income", "unassigned"];

export interface ComponentRow {
  accountId: string;
  code: string;
  name: string;
  amounts: Record<Component, string>;
}

export interface PrincipalIncomeStatement {
  from: string;
  to: string;
  receipts: ComponentRow[];
  disbursements: ComponentRow[];
  distributions: Record<Component, string>;
  totals: Record<Component, { receipts: string; disbursements: string; distributions: string; net: string }>;
}

async function distributionsAccountIds(db: DbOrTx, orgId: string): Promise<string[]> {
  const rows = await db.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.orgId, orgId), eq(accounts.systemKey, "distributions")));
  return rows.map((r) => r.id);
}

/** Receipts, disbursements and distributions for a period, principal and income side by side. */
export async function principalIncomeStatement(db: DbOrTx, orgId: string, from: string, to: string): Promise<PrincipalIncomeStatement> {
  const res = await db.execute<{ account_id: string; code: string; name: string; type: string; component: Component | null; amount: string }>(sql`
    select a.id as account_id, a.code, a.name, a.type, l.trust_component as component, sum(l.base_amount)::text as amount
    from journal_lines l
    join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
    join accounts a on a.org_id = l.org_id and a.id = l.account_id
    where l.org_id = ${orgId} and e.status = 'posted' and e.entry_date between ${from} and ${to} and a.type in ('income','expense')
    group by a.id, a.code, a.name, a.type, l.trust_component
    order by a.code
  `);
  const build = (type: string, sign: 1 | -1) => {
    const m = new Map<string, ComponentRow>();
    for (const r of res.rows.filter((x) => x.type === type)) {
      let row = m.get(r.account_id);
      if (!row) m.set(r.account_id, (row = { accountId: r.account_id, code: r.code, name: r.name, amounts: { principal: "0", income: "0", unassigned: "0" } }));
      const c = r.component ?? "unassigned";
      row.amounts[c] = Decimal.from(row.amounts[c]).add(Decimal.from(r.amount).mul(sign)).toString();
    }
    return [...m.values()];
  };
  const receipts = build("income", -1);
  const disbursements = build("expense", 1);
  const dist = await distributionTotals(db, orgId, from, to);
  const totals = {} as PrincipalIncomeStatement["totals"];
  for (const c of COMPONENTS) {
    const r = Decimal.sum(receipts.map((x) => x.amounts[c]));
    const d = Decimal.sum(disbursements.map((x) => x.amounts[c]));
    const ds = Decimal.from(dist[c]);
    totals[c] = { receipts: r.toString(), disbursements: d.toString(), distributions: ds.toString(), net: r.sub(d).sub(ds).toString() };
  }
  return { from, to, receipts, disbursements, distributions: dist, totals };
}

async function distributionTotals(db: DbOrTx, orgId: string, from: string | null, to: string): Promise<Record<Component, string>> {
  const ids = await distributionsAccountIds(db, orgId);
  const out: Record<Component, string> = { principal: "0", income: "0", unassigned: "0" };
  if (!ids.length) return out;
  const res = await db.execute<{ component: Component | null; amount: string }>(sql`
    select l.trust_component as component, sum(l.base_amount)::text as amount
    from journal_lines l
    join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
    where l.org_id = ${orgId} and e.status = 'posted' and e.entry_date <= ${to}
      ${from ? sql`and e.entry_date >= ${from}` : sql``}
      and l.account_id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
    group by l.trust_component
  `);
  for (const r of res.rows) out[r.component ?? "unassigned"] = Decimal.from(out[r.component ?? "unassigned"]).add(r.amount).toString();
  return out;
}

export interface BeneficiaryDistribution {
  beneficiaryId: string | null;
  beneficiaryName: string;
  principal: string;
  income: string;
  unassigned: string;
  total: string;
  entries: { entryId: string; entryNumber: number | null; date: string; component: Component; amount: string; description: string }[];
}

/** Distributions to each beneficiary in a period, by component, with the entries behind them. */
export async function beneficiaryDistributions(db: DbOrTx, orgId: string, from: string, to: string): Promise<BeneficiaryDistribution[]> {
  const ids = await distributionsAccountIds(db, orgId);
  if (!ids.length) return [];
  const res = await db.execute<{ beneficiary_id: string | null; name: string | null; entry_id: string; entry_number: number | null; entry_date: string; component: Component | null; amount: string; description: string }>(sql`
    select l.beneficiary_id, c.display_name as name, e.id as entry_id, e.entry_number, e.entry_date, l.trust_component as component,
           l.base_amount::text as amount, coalesce(l.description, e.description) as description
    from journal_lines l
    join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
    left join contacts c on c.org_id = l.org_id and c.id = l.beneficiary_id
    where l.org_id = ${orgId} and e.status = 'posted' and e.entry_date between ${from} and ${to}
      and l.account_id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
    order by c.display_name nulls last, e.entry_date, e.entry_number
  `);
  const m = new Map<string, BeneficiaryDistribution>();
  for (const r of res.rows) {
    const k = r.beneficiary_id ?? "none";
    let b = m.get(k);
    if (!b) m.set(k, (b = { beneficiaryId: r.beneficiary_id, beneficiaryName: r.name ?? "No beneficiary recorded", principal: "0", income: "0", unassigned: "0", total: "0", entries: [] }));
    const c = r.component ?? "unassigned";
    b[c] = Decimal.from(b[c]).add(r.amount).toString();
    b.total = Decimal.from(b.total).add(r.amount).toString();
    b.entries.push({ entryId: r.entry_id, entryNumber: r.entry_number, date: r.entry_date, component: c, amount: r.amount, description: r.description });
  }
  return [...m.values()];
}

/** Income-side receipts less income-side disbursements and income distributions, to date and for the period. */
export async function undistributedIncome(db: DbOrTx, orgId: string, from: string, to: string) {
  const period = await principalIncomeStatement(db, orgId, from, to);
  const sinceInception = await principalIncomeStatement(db, orgId, "0001-01-01", to);
  return {
    period: period.totals.income,
    toDate: sinceInception.totals.income,
  };
}

/**
 * Record a distribution to a beneficiary: Dr distributions, Cr the account it
 * was paid from, both tagged with the beneficiary and the side of the trust.
 * Recording it does not pay anyone.
 */
export async function recordDistribution(
  ctx: Ctx,
  input: { beneficiaryId: string; component: "principal" | "income"; amount: string; date: string; paidFromAccountId: string; memo?: string | null },
) {
  requirePermission(ctx, "ledger.post");
  const fields: Record<string, string> = {};
  if (!isIsoDate(input.date)) fields.date = "Enter the date.";
  const amount = Decimal.tryFrom(input.amount?.replace(/,/g, "").trim());
  if (!amount || !amount.isPositive()) fields.amount = "Enter the amount distributed.";
  else if (amount.decimalPlaces > minorUnits(ctx.org.baseCurrency)) fields.amount = "Too many decimal places.";
  if (input.component !== "principal" && input.component !== "income") fields.component = "Say whether it comes from principal or income.";
  if (!input.beneficiaryId) fields.beneficiaryId = "Choose the beneficiary.";
  if (!input.paidFromAccountId) fields.paidFromAccountId = "Choose the account it was paid from.";
  if (Object.keys(fields).length) throw new ValidationError("Check the distribution.", fields);
  return withTransaction(async (tx) => {
    const [b] = await tx.select().from(contacts).where(and(eq(contacts.orgId, ctx.orgId), eq(contacts.id, input.beneficiaryId)));
    if (!b) throw new NotFoundError("The beneficiary");
    if (!b.isBeneficiary) throw new ValidationError(`${b.displayName} is not marked as a beneficiary. Edit the contact first.`, { beneficiaryId: "Not a beneficiary." });
    const [bank] = await tx.select().from(accounts).where(and(eq(accounts.orgId, ctx.orgId), eq(accounts.id, input.paidFromAccountId)));
    if (!bank || !["bank", "cash", "clearing"].includes(bank.subtype)) throw new ValidationError("Pay from a bank or cash account.", { paidFromAccountId: "Not a money account." });
    const dist = await systemAccountId(tx, ctx.orgId, "distributions");
    const description = input.memo?.trim() || `Distribution of ${input.component} to ${b.displayName}`;
    const posted = await postEntry(tx, ctx, {
      kind: "manual",
      entryDate: input.date,
      description,
      sourceType: "trust_distribution",
      sourceId: b.id,
      lines: [
        { accountId: dist, amount: amount!.toString(), contactId: b.id, beneficiaryId: b.id, trustComponent: input.component, description },
        { accountId: bank.id, amount: amount!.neg().toString(), contactId: b.id, beneficiaryId: b.id, trustComponent: input.component, description },
      ],
    });
    await audit(tx, ctx, { action: "trust.distribution_recorded", entityType: "contact", entityId: b.id, metadata: { amount: amount!.toString(), component: input.component, date: input.date, entryId: posted.entry.id } });
    return posted;
  });
}
