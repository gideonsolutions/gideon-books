import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { recordPayment } from "@/lib/commerce/payments";
import { balanceSheet, cashFlow, profitAndLoss, trialBalance } from "@/lib/reports/statements";
import { generalLedger } from "@/lib/reports/gl";
import { accountActivity, journalReport } from "@/lib/reports/operational";
import { buildReport } from "@/lib/reports/registry";
import { resolveParams } from "@/lib/reports/scope";
import { toCsv, toPdf } from "@/lib/reports/export";
import { Decimal } from "@/lib/money/decimal";
import { customer, setupOrg, type TestOrg } from "../helpers";
import { amt, cell, doc, journal, parseCsv, pdfText } from "./helpers";
import type { ReportTable } from "@/lib/reports/table";

let t: TestOrg;

beforeAll(async () => {
  t = await setupOrg({ name: "Statements Co" });
  const c = await customer(t.ctx, "Statement Customer");
  await journal(t.ctx, "2025-03-01", [
    [await t.acct("1000"), "10000"],
    [await t.acct("owner_contributions"), "-10000"],
  ]);
  const inv = await doc(t.ctx, "invoice", c.id, "2025-06-15", [{ unitPrice: "1000", accountId: await t.acct("4100") }]);
  await recordPayment(t.ctx, { kind: "customer_payment", contactId: c.id, paymentDate: "2025-07-01", accountId: await t.acct("1000"), amount: "1000", allocations: [{ itemType: "document", itemId: inv.id, amount: "1000" }] });
  await journal(t.ctx, "2025-08-01", [
    [await t.acct("6500"), "200"],
    [await t.acct("1000"), "-200"],
  ]);
  await doc(t.ctx, "invoice", c.id, "2026-02-01", [{ unitPrice: "500", accountId: await t.acct("4100") }]);
  await journal(t.ctx, "2026-02-10", [
    [await t.acct("6550"), "300"],
    [await t.acct("1000"), "-300"],
  ]);
});

/** Sum the general-ledger lines behind a drill-down link (debits − credits). */
async function glSum(href: string): Promise<Decimal> {
  const q = new URL(`http://x${href}`).searchParams;
  const p: Record<string, string> = {};
  q.forEach((v, k) => (p[k] = v));
  const r = resolveParams(t.ctx.org, p.to && !p.from ? { ...p, from: "1900-01-01" } : p);
  const gl = await generalLedger(getDb(), t.ctx.org, { from: r.from, to: r.to, basis: r.basis, filters: r.filters, pageSize: null });
  return Decimal.sum(gl.accounts.map((a) => a.debits.sub(a.credits)));
}

describe("financial statements", () => {
  it("trial balance sums to zero with prior years' earnings as one line", async () => {
    const tb = await trialBalance(getDb(), t.ctx.org, { asOf: "2026-03-31", basis: "accrual" });
    expect(tb.totalDebit.toFixed(2)).toBe("11300.00");
    expect(tb.totalCredit.toFixed(2)).toBe("11300.00");
    const re = tb.rows.find((r) => r.accountId === null)!;
    expect(re.credit.toFixed(2)).toBe("800.00");
  });

  it("balance sheet balances with retained and current-year earnings", async () => {
    const bs = await balanceSheet(getDb(), t.ctx.org, { asOf: "2026-03-31", basis: "accrual" });
    expect(bs.totalAssets[0]!.toFixed(2)).toBe("11000.00");
    expect(bs.totalLiabilities[0]!.toFixed(2)).toBe("0.00");
    expect(bs.priorEarnings[0]!.toFixed(2)).toBe("800.00");
    expect(bs.currentEarnings[0]!.toFixed(2)).toBe("200.00");
    expect(bs.totalEquity[0]!.toFixed(2)).toBe("11000.00");
    expect(bs.difference[0]!.isZero()).toBe(true);
    expect(bs.table.warnings).toBeUndefined();
  });

  it("net income on the P&L equals current-year earnings on the balance sheet", async () => {
    const pl = await profitAndLoss(getDb(), t.ctx.org, { from: "2026-01-01", to: "2026-03-31", basis: "accrual" });
    expect(pl.income[0]!.toFixed(2)).toBe("500.00");
    expect(pl.expenses[0]!.toFixed(2)).toBe("300.00");
    expect(pl.netIncome[0]!.toFixed(2)).toBe("200.00");
  });

  it("compares month by month with a total column", async () => {
    const pl = await profitAndLoss(getDb(), t.ctx.org, { from: "2026-01-01", to: "2026-03-31", basis: "accrual", compare: "months" });
    expect(pl.columns.map((c) => c.label)).toEqual(["2026-01", "2026-02", "2026-03", "Total"]);
    expect(pl.netIncome.map((v) => v.toFixed(2))).toEqual(["0.00", "200.00", "0.00", "200.00"]);
    const py = await profitAndLoss(getDb(), t.ctx.org, { from: "2026-01-01", to: "2026-12-31", basis: "accrual", compare: "previous_year" });
    expect(py.netIncome.map((v) => v.toFixed(2))).toEqual(["200.00", "800.00"]);
  });

  it("cash flow ties to the change in cash", async () => {
    const cf = await cashFlow(getDb(), t.ctx.org, { from: "2026-01-01", to: "2026-03-31", basis: "accrual" });
    expect(cf.netIncome.toFixed(2)).toBe("200.00");
    expect(cf.operating.toFixed(2)).toBe("-300.00");
    expect(cf.cashBeginning.toFixed(2)).toBe("10800.00");
    expect(cf.cashEnding.toFixed(2)).toBe("10500.00");
    expect(cf.difference.isZero()).toBe(true);
    const year = await cashFlow(getDb(), t.ctx.org, { from: "2025-01-01", to: "2025-12-31", basis: "accrual" });
    expect(year.financing.toFixed(2)).toBe("10000.00");
    expect(year.difference.isZero()).toBe(true);
  });

  it("every figure drills down to general-ledger lines that sum to it", async () => {
    const tables: ReportTable[] = [
      (await trialBalance(getDb(), t.ctx.org, { asOf: "2026-03-31", basis: "accrual" })).table,
      (await balanceSheet(getDb(), t.ctx.org, { asOf: "2026-03-31", basis: "accrual" })).table,
      (await profitAndLoss(getDb(), t.ctx.org, { from: "2026-01-01", to: "2026-03-31", basis: "accrual" })).table,
    ];
    let checked = 0;
    for (const table of tables) {
      for (const row of table.rows) {
        for (let i = 1; i < row.cells.length; i++) {
          const c = row.cells[i]!;
          if (!c.href?.startsWith("/reports/general-ledger") || c.value === null) continue;
          const col = table.columns[i]!;
          const gl = await glSum(c.href);
          // Statements show credits as positive for liability, equity and income rows.
          const shown = Decimal.from(c.value);
          const ok = gl.eq(shown) || gl.neg().eq(shown) || (col.key === "credit" && gl.neg().eq(shown)) || (col.key === "debit" && gl.eq(shown));
          expect(ok, `${table.key} ${row.cells[0]?.value} ${col.label}: report ${shown} vs ledger ${gl}`).toBe(true);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  it("exports CSV and PDF from the same table", async () => {
    const table = await buildReport(getDb(), t.ctx.org, "trial-balance", { to: "2026-03-31", basis: "accrual" });
    const csv = parseCsv(toCsv(table));
    const header = csv.findIndex((r) => r[0] === "Account");
    const total = csv.slice(header).find((r) => r[0] === "Total")!;
    expect(total[2]).toBe(cell(table, "Total", 2));
    expect(amt(total[2])).toBe("11300.00");
    const pdf = await toPdf(table, "Statements Co");
    expect(Buffer.from(pdf).subarray(0, 5).toString()).toBe("%PDF-");
    const text = pdfText(pdf);
    expect(text).toContain("Trial balance");
    expect(text).toContain("11,300.00");
  });

  it("GL detail carries running balances and the journal and activity reports agree", async () => {
    const gl = await generalLedger(getDb(), t.ctx.org, { from: "2026-01-01", to: "2026-03-31", basis: "accrual", filters: { accountIds: [await t.acct("1000")] } });
    expect(gl.accounts).toHaveLength(1);
    const a = gl.accounts[0]!;
    expect(a.opening.toFixed(2)).toBe("10800.00");
    expect(a.closing.toFixed(2)).toBe("10500.00");
    expect(a.lines.at(-1)!.running.toFixed(2)).toBe("10500.00");
    const j = await journalReport(getDb(), t.ctx.org, { from: "2026-01-01", to: "2026-03-31", basis: "accrual" });
    expect(j.debit.eq(j.credit)).toBe(true);
    const act = await accountActivity(getDb(), t.ctx.org, { from: "2026-01-01", to: "2026-03-31", basis: "accrual" });
    expect(cell(act.table, "1000 Checking", 4)).toBe("10500.0000");
  });
});

describe("fiscal years not starting in January", () => {
  it("splits retained and current earnings at the fiscal-year boundary", async () => {
    const o = await setupOrg({ name: "July FY", fiscalYearStartMonth: 7 });
    await journal(o.ctx, "2025-08-01", [
      [await o.acct("1000"), "1000"],
      [await o.acct("owner_contributions"), "-1000"],
    ]);
    await journal(o.ctx, "2026-03-01", [
      [await o.acct("1000"), "500"],
      [await o.acct("4100"), "-500"],
    ]);
    await journal(o.ctx, "2026-08-01", [
      [await o.acct("6500"), "100"],
      [await o.acct("1000"), "-100"],
    ]);
    const june = await balanceSheet(getDb(), o.ctx.org, { asOf: "2026-06-30", basis: "accrual" });
    expect(june.priorEarnings[0]!.toFixed(2)).toBe("0.00");
    expect(june.currentEarnings[0]!.toFixed(2)).toBe("500.00");
    const sep = await balanceSheet(getDb(), o.ctx.org, { asOf: "2026-09-30", basis: "accrual", compare: "previous_year" });
    expect(sep.priorEarnings.map((v) => v.toFixed(2))).toEqual(["500.00", "0.00"]);
    expect(sep.currentEarnings.map((v) => v.toFixed(2))).toEqual(["-100.00", "0.00"]);
    expect(sep.totalAssets[0]!.toFixed(2)).toBe("1400.00");
    expect(sep.difference.every((d) => d.isZero())).toBe(true);
    const tb = await trialBalance(getDb(), o.ctx.org, { asOf: "2026-09-30", basis: "accrual" });
    expect(tb.totalDebit.eq(tb.totalCredit)).toBe(true);
  });
});
