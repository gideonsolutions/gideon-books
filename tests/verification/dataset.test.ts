/**
 * The synthetic dataset, loaded through the application's services, checked
 * against results worked out by hand (expected.ts).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getDb, withTransaction } from "@/lib/db/client";
import { loadSyntheticDataset, type DatasetRefs } from "@/lib/demo/dataset";
import { openItemsForContact } from "@/lib/commerce/open-items";
import { inventoryReconciliation } from "@/lib/inventory/valuation";
import { postEntry } from "@/lib/ledger/posting";
import { Decimal } from "@/lib/money/decimal";
import { refresh, rejectsWith, setupOrg, type TestOrg } from "../helpers";
import {
  EXPECTED_ACCRUAL_BALANCES,
  EXPECTED_CASH_BALANCES,
  EXPECTED_INVENTORY,
  EXPECTED_NET_INCOME_ACCRUAL,
  EXPECTED_NET_INCOME_CASH,
  EXPECTED_OPEN_ITEMS,
  EXPECTED_SALES_TAX,
} from "./expected";

let t: TestOrg;
let refs: DatasetRefs;
const Y = 2025;

beforeAll(async () => {
  t = await setupOrg({ name: "Harbor & Pine Supply", template: "products", booksStartDate: `${Y}-01-01` });
  refs = await loadSyntheticDataset(t.ctx, { year: Y });
  t.ctx = await refresh(t.ctx);
}, 120_000);

async function balancesByCode(basis: "accrual" | "cash", asOf: string): Promise<Map<string, string>> {
  // An independent statement of the cash-basis policy in SQL (the reports module has its own implementation).
  const q =
    basis === "accrual"
      ? sql`
        select a.code, coalesce(sum(l.base_amount), 0)::text as b
        from accounts a
        left join journal_lines l on l.org_id = a.org_id and l.account_id = a.id
          and exists (select 1 from journal_entries e where e.id = l.entry_id and e.status = 'posted' and e.entry_date <= ${asOf})
        where a.org_id = ${t.orgId}
        group by a.code`
      : sql`
        with noncash as (
          select id from settlements where org_id = ${t.orgId} and debit_item_type = 'document' and credit_item_type = 'document'
        ),
        lines as (
          select l.account_id, l.base_amount
          from journal_lines l join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
          where l.org_id = ${t.orgId} and e.status = 'posted' and e.entry_date <= ${asOf}
            and (e.cash_basis = 'as_is'
                 or (e.cash_basis = 'settlement' and coalesce(l.open_item_type, '') <> 'document'
                     and not (e.source_type = 'settlement' and e.source_id in (select id from noncash))))
          union all
          select c.account_id, c.base_amount from cash_basis_lines c
          where c.org_id = ${t.orgId} and c.entry_date <= ${asOf} and c.settlement_id not in (select id from noncash)
        )
        select a.code, coalesce(sum(lines.base_amount), 0)::text as b
        from accounts a left join lines on lines.account_id = a.id
        where a.org_id = ${t.orgId}
        group by a.code`;
  const r = await getDb().execute<{ code: string; b: string }>(q);
  return new Map(r.rows.map((x) => [x.code, Decimal.from(x.b).round(2, "half_up").toFixed(2)]));
}

function checkBalances(actual: Map<string, string>, expected: Record<string, string>) {
  const mismatches: string[] = [];
  for (const [code, bal] of actual) {
    const want = expected[code] ?? "0.00";
    if (bal !== want) mismatches.push(`${code}: expected ${want}, got ${bal}`);
  }
  for (const code of Object.keys(expected)) if (!actual.has(code)) mismatches.push(`${code}: account missing`);
  expect(mismatches).toEqual([]);
}

describe("synthetic dataset", () => {
  it("produces the hand-computed accrual balances, and the trial balance is zero", async () => {
    const b = await balancesByCode("accrual", `${Y}-04-30`);
    checkBalances(b, EXPECTED_ACCRUAL_BALANCES);
    expect(Decimal.sum([...b.values()]).toFixed(2)).toBe("0.00");
    const income = Decimal.sum([...b.entries()].filter(([c]) => c.startsWith("4")).map(([, v]) => v)).neg();
    const expense = Decimal.sum([...b.entries()].filter(([c]) => /^[567]/.test(c)).map(([, v]) => v));
    expect(income.sub(expense).toFixed(2)).toBe(EXPECTED_NET_INCOME_ACCRUAL);
  });

  it("produces the hand-computed cash-basis balances, which also balance", async () => {
    const b = await balancesByCode("cash", `${Y}-04-30`);
    checkBalances(b, EXPECTED_CASH_BALANCES);
    expect(Decimal.sum([...b.values()]).toFixed(2)).toBe("0.00");
    const income = Decimal.sum([...b.entries()].filter(([c]) => c.startsWith("4")).map(([, v]) => v)).neg();
    const expense = Decimal.sum([...b.entries()].filter(([c]) => /^[567]/.test(c)).map(([, v]) => v));
    expect(income.sub(expense).toFixed(2)).toBe(EXPECTED_NET_INCOME_CASH);
  });

  it("leaves the expected open items, and the subledgers equal the control accounts", async () => {
    const db = getDb();
    for (const exp of EXPECTED_OPEN_ITEMS.receivables) {
      const items = await openItemsForContact(db, t.orgId, "receivables", refs.contacts[exp.contact]!);
      expect(Decimal.sum(items.map((i) => i.openTxn)).toFixed(2)).toBe(exp.amount);
    }
    for (const exp of EXPECTED_OPEN_ITEMS.payables) {
      const items = await openItemsForContact(db, t.orgId, "payables", refs.contacts[exp.contact]!);
      expect(Decimal.sum(items.map((i) => i.openTxn)).toFixed(2)).toBe(exp.amount);
    }
    const dep = await openItemsForContact(db, t.orgId, "receivables", refs.contacts.harborview!);
    expect(Decimal.sum(dep.filter((i) => i.kind === "customer_deposit").map((i) => i.openTxn)).toFixed(2)).toBe(EXPECTED_OPEN_ITEMS.deposits[0]!.amount);
  });

  it("values stock at moving average and reconciles it to the inventory account", async () => {
    const r = await getDb().execute<{ q: string; v: string }>(sql`select qty_on_hand::text as q, total_value::text as v from item_costs where org_id = ${t.orgId} and item_id = ${refs.items.widget}`);
    expect(Decimal.from(r.rows[0]!.q).normalize().toString()).toBe(EXPECTED_INVENTORY.widgetQty);
    expect(Decimal.from(r.rows[0]!.v).toFixed(2)).toBe(EXPECTED_INVENTORY.widgetValue);
    const rec = await inventoryReconciliation(getDb(), t.orgId, `${Y}-04-30`);
    expect(Decimal.from(rec.difference).isZero()).toBe(true);
  });

  it("records the sales tax collected and remitted", async () => {
    const r = await getDb().execute<{ taxable: string; tax: string }>(sql`
      select coalesce(sum(case when d.kind = 'credit_note' then -t.taxable_amount else t.taxable_amount end), 0)::text as taxable,
             coalesce(sum(case when d.kind = 'credit_note' then -t.tax_amount else t.tax_amount end), 0)::text as tax
      from document_line_taxes t join documents d on d.org_id = t.org_id and d.id = t.document_id
      where t.org_id = ${t.orgId} and d.status <> 'void' and d.status <> 'draft'`);
    expect(Decimal.from(r.rows[0]!.taxable).toFixed(2)).toBe(EXPECTED_SALES_TAX.taxableSales);
    expect(Decimal.from(r.rows[0]!.tax).toFixed(2)).toBe(EXPECTED_SALES_TAX.taxCollected);
  });

  it("the reports module produces the same figures", async () => {
    const { trialBalance, balanceSheet, profitAndLoss } = await import("@/lib/reports/statements");
    const { aging } = await import("@/lib/reports/aging");
    const { salesTaxLiability } = await import("@/lib/reports/salestax");
    const db = getDb();
    const codes = new Map((await db.execute<{ id: string; code: string }>(sql`select id, code from accounts where org_id = ${t.orgId}`)).rows.map((r) => [r.id, r.code]));
    for (const [basis, expected, ni] of [
      ["accrual", EXPECTED_ACCRUAL_BALANCES, EXPECTED_NET_INCOME_ACCRUAL],
      ["cash", EXPECTED_CASH_BALANCES, EXPECTED_NET_INCOME_CASH],
    ] as const) {
      const tb = await trialBalance(db, t.ctx.org, { asOf: `${Y}-04-30`, basis });
      expect(tb.totalDebit.eq(tb.totalCredit)).toBe(true);
      for (const r of tb.rows) {
        if (!r.accountId) continue;
        const code = codes.get(r.accountId)!;
        expect(`${basis} ${code} ${r.debit.sub(r.credit).toFixed(2)}`).toBe(`${basis} ${code} ${expected[code] ?? "0.00"}`);
      }
      const pl = await profitAndLoss(db, t.ctx.org, { from: `${Y}-01-01`, to: `${Y}-04-30`, basis });
      expect(pl.netIncome[0]!.toFixed(2)).toBe(ni);
      const bs = await balanceSheet(db, t.ctx.org, { asOf: `${Y}-04-30`, basis });
      expect(bs.difference[0]!.isZero()).toBe(true);
    }
    const ar = await aging(db, t.ctx.org, { side: "receivables", asOf: `${Y}-04-30` });
    expect(ar.total.toFixed(2)).toBe("209.50");
    expect(ar.total.eq(ar.controlBalance)).toBe(true);
    const ap = await aging(db, t.ctx.org, { side: "payables", asOf: `${Y}-04-30` });
    expect(ap.total.abs().toFixed(2)).toBe("490.00");
    const st = await salesTaxLiability(db, t.ctx.org, { from: `${Y}-01-01`, to: `${Y}-04-30` });
    expect(st.rows[0]!.taxableSales.toFixed(2)).toBe(EXPECTED_SALES_TAX.taxableSales);
    expect(st.rows[0]!.taxCharged.toFixed(2)).toBe(EXPECTED_SALES_TAX.taxCollected);
    expect(st.rows[0]!.remitted.abs().toFixed(2)).toBe(EXPECTED_SALES_TAX.remitted);
    expect(st.rows[0]!.closing.abs().toFixed(2)).toBe(EXPECTED_SALES_TAX.owing);
  });

  it("imports April's statement and matches every line but the fee, then reconciles", async () => {
    const r = await getDb().execute<{ status: string; n: number }>(sql`select status, count(*)::int as n from bank_transactions where org_id = ${t.orgId} group by status order by status`);
    const byStatus = Object.fromEntries(r.rows.map((x) => [x.status, x.n]));
    // Rent 1,500, remittance of payroll liabilities 777.00 and the refund 108.65 matched; the fee categorized.
    expect(byStatus.matched).toBe(3);
    expect(byStatus.categorized).toBe(1);
    expect(byStatus.unreviewed ?? 0).toBe(0);
    const rec = await getDb().execute<{ status: string; statement_balance: string }>(sql`select status, statement_balance::text from reconciliations where org_id = ${t.orgId}`);
    expect(rec.rows).toHaveLength(1);
    expect(rec.rows[0]!.status).toBe("completed");
    expect(Decimal.from(rec.rows[0]!.statement_balance).toFixed(2)).toBe(EXPECTED_ACCRUAL_BALANCES["1000"]);
  });

  it("keeps closed periods closed", async () => {
    await rejectsWith(
      withTransaction(async (tx) =>
        postEntry(tx, t.ctx, {
          kind: "manual",
          entryDate: `${Y}-02-10`,
          description: "late entry",
          lines: [
            { accountId: await t.acct("1000"), amount: "1" },
            { accountId: await t.acct("4100"), amount: "-1" },
          ],
        }),
      ),
      "period_closed",
    );
  });
});
