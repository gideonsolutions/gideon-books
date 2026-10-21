import { describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { projects } from "@/lib/db/schema/ledger";
import { recordPayment } from "@/lib/commerce/payments";
import { postManualEntry } from "@/lib/ledger/journals";
import { createJurisdiction, addTaxRate, saveTaxCode } from "@/lib/tax/config";
import { recordTaxAdjustment, recordTaxRemittance } from "@/lib/tax/remittance";
import { aging, contactBalances } from "@/lib/reports/aging";
import { salesTaxLiability } from "@/lib/reports/salestax";
import { inventoryValuation, projectProfitability } from "@/lib/reports/operational";
import { budgetVsActual, createBudget, getBudget, saveBudgetCells } from "@/lib/budgets/budgets";
import { buildReport } from "@/lib/reports/registry";
import { toCsv } from "@/lib/reports/export";
import { balance, customer, rejectsWith, setupOrg, stockItem, vendor } from "../helpers";
import { amt, doc, parseCsv } from "./helpers";

describe("aging and balances", () => {
  it("buckets open items by days past due and totals to the control accounts", async () => {
    const o = await setupOrg();
    const a = await customer(o.ctx, "Alpha");
    const b = await customer(o.ctx, "Beta");
    const income = await o.acct("4100");
    const bank = await o.acct("1000");
    const inv1 = await doc(o.ctx, "invoice", a.id, "2026-01-10", [{ unitPrice: "1000", accountId: income }], { dueDate: "2026-02-09" });
    await doc(o.ctx, "invoice", a.id, "2026-04-15", [{ unitPrice: "500", accountId: income }], { dueDate: "2026-05-15" });
    await doc(o.ctx, "invoice", b.id, "2026-05-20", [{ unitPrice: "300", accountId: income }], { dueDate: "2026-06-19" });
    await recordPayment(o.ctx, { kind: "customer_payment", contactId: a.id, paymentDate: "2026-03-01", accountId: bank, amount: "300", allocations: [{ itemType: "document", itemId: inv1.id, amount: "300" }] });
    await recordPayment(o.ctx, { kind: "customer_payment", contactId: a.id, paymentDate: "2026-05-25", accountId: bank, amount: "200" });
    await recordPayment(o.ctx, { kind: "customer_deposit", contactId: b.id, paymentDate: "2026-05-26", accountId: bank, amount: "50" });
    const ar = await aging(getDb(), o.ctx.org, { side: "receivables", asOf: "2026-05-31", detail: true });
    expect(ar.buckets.map((x) => x.toFixed(2))).toEqual(["100.00", "500.00", "0.00", "0.00", "700.00"]);
    expect(ar.total.toFixed(2)).toBe("1300.00");
    expect(ar.total.eq(ar.controlBalance)).toBe(true);
    expect(await balance(o.orgId, await o.acct("accounts_receivable"), "2026-05-31")).toBe("1300.00");
    expect(ar.table.warnings).toBeUndefined();
    // As of an earlier date only what existed then.
    const march = await aging(getDb(), o.ctx.org, { side: "receivables", asOf: "2026-03-31" });
    expect(march.total.toFixed(2)).toBe("700.00");
    expect(march.total.eq(march.controlBalance)).toBe(true);

    const v = await vendor(o.ctx);
    await doc(o.ctx, "bill", v.id, "2026-04-01", [{ unitPrice: "400", accountId: await o.acct("6550") }], { dueDate: "2026-04-30", reference: "R-1" });
    const ap = await aging(getDb(), o.ctx.org, { side: "payables", asOf: "2026-05-31" });
    expect(ap.buckets.map((x) => x.toFixed(2))).toEqual(["0.00", "0.00", "400.00", "0.00", "0.00"]);
    expect(ap.total.eq(ap.controlBalance)).toBe(true);

    const cb = await contactBalances(getDb(), o.ctx.org, { side: "receivables", asOf: "2026-05-31" });
    expect(cb.total.toFixed(2)).toBe("1300.00");
    expect(cb.deposits.toFixed(2)).toBe("50.00");
  });
});

describe("sales tax liability", () => {
  it("reports taxable and exempt sales, tax charged, collected, remitted and owed", async () => {
    const o = await setupOrg();
    const j = await createJurisdiction(o.ctx, { name: "State" });
    await addTaxRate(o.ctx, { jurisdictionId: j.id, name: "State 10%", rate: "10", effectiveFrom: "2020-01-01" });
    const code = await saveTaxCode(o.ctx, { name: "ST", components: [{ jurisdictionId: j.id }] });
    const c = await customer(o.ctx, "Taxable Co");
    const ex = await customer(o.ctx, "Exempt Church", { taxExempt: true, taxExemptionReason: "Religious organization" });
    const income = await o.acct("4100");
    await doc(o.ctx, "invoice", c.id, "2026-07-05", [{ unitPrice: "1000", accountId: income, taxCodeId: code.id }]);
    await doc(o.ctx, "invoice", ex.id, "2026-07-06", [{ unitPrice: "200", accountId: income, taxCodeId: code.id }]);
    await doc(o.ctx, "credit_note", c.id, "2026-07-10", [{ unitPrice: "100", accountId: income, taxCodeId: code.id }]);
    await recordTaxRemittance(o.ctx, { jurisdictionId: j.id, date: "2026-07-31", amount: "50", paidFromAccountId: await o.acct("1000") });
    await recordTaxAdjustment(o.ctx, { jurisdictionId: j.id, date: "2026-07-31", amount: "5", offsetAccountId: await o.acct("6700"), reason: "Late filing penalty" });
    const r = await salesTaxLiability(getDb(), o.ctx.org, { from: "2026-07-01", to: "2026-07-31" });
    const row = r.rows.find((x) => x.jurisdictionId === j.id)!;
    expect(row.taxableSales.toFixed(2)).toBe("900.00");
    expect(row.exemptSales.toFixed(2)).toBe("200.00");
    expect(row.taxCharged.toFixed(2)).toBe("90.00");
    expect(row.collected.toFixed(2)).toBe("90.00");
    expect(row.remitted.toFixed(2)).toBe("50.00");
    expect(row.adjustments.toFixed(2)).toBe("5.00");
    expect(row.closing.toFixed(2)).toBe("45.00");
    expect(await balance(o.orgId, await o.acct("sales_tax_payable"))).toBe("-45.00");
    const aug = await salesTaxLiability(getDb(), o.ctx.org, { from: "2026-08-01", to: "2026-08-31" });
    expect(aug.rows.find((x) => x.jurisdictionId === j.id)!.opening.toFixed(2)).toBe("45.00");
  });
});

describe("projects, inventory and budgets", () => {
  it("computes project profitability from lines tagged with the project", async () => {
    const o = await setupOrg();
    const c = await customer(o.ctx);
    const [p] = await getDb().insert(projects).values({ orgId: o.orgId, name: "Kitchen remodel", customerId: c.id, budgetAmount: "500" }).returning();
    await doc(o.ctx, "invoice", c.id, "2026-02-01", [{ unitPrice: "1000", accountId: await o.acct("4100"), projectId: p!.id }]);
    await postManualEntry(o.ctx, {
      entryDate: "2026-02-06",
      description: "Subcontractor",
      lines: [
        { accountId: await o.acct("6450"), debit: "300", projectId: p!.id },
        { accountId: await o.acct("1000"), credit: "300" },
      ],
    });
    const r = await projectProfitability(getDb(), o.ctx.org, { from: "2026-01-01", to: "2026-12-31", basis: "accrual" });
    const row = r.rows.find((x) => x.projectId === p!.id)!;
    expect(row.income.toFixed(2)).toBe("1000.00");
    expect(row.costs.toFixed(2)).toBe("300.00");
    expect(row.profit.toFixed(2)).toBe("700.00");
    expect(row.margin!.toString()).toBe("70.0");
  });

  it("values inventory from the stock ledger and reconciles to the ledger", async () => {
    const o = await setupOrg();
    const v = await vendor(o.ctx);
    const c = await customer(o.ctx);
    const w = await stockItem(o.ctx, "Gizmo");
    await doc(o.ctx, "bill", v.id, "2026-03-01", [{ itemId: w.id, quantity: "10", unitPrice: "4" }], { reference: "B1" });
    await doc(o.ctx, "invoice", c.id, "2026-03-05", [{ itemId: w.id, quantity: "4", unitPrice: "9" }]);
    const r = await inventoryValuation(getDb(), o.ctx.org, { asOf: "2026-03-31" });
    expect(r.rows[0]!.quantity.toString()).toBe("6.000000");
    expect(r.total.toFixed(2)).toBe("24.00");
    expect(r.reconciliation.difference).toBe("0.0000");
    const before = await inventoryValuation(getDb(), o.ctx.org, { asOf: "2026-03-02" });
    expect(before.total.toFixed(2)).toBe("40.00");
  });

  it("compares a budget with actuals and copies last year's actuals", async () => {
    const o = await setupOrg();
    const c = await customer(o.ctx);
    const income = await o.acct("4100");
    const rent = await o.acct("6550");
    await doc(o.ctx, "invoice", c.id, "2026-01-15", [{ unitPrice: "800", accountId: income }]);
    const b = await createBudget(o.ctx, { name: "Plan 2026", fiscalYearStart: "2026-01-01" });
    await saveBudgetCells(o.ctx, b.id, [
      { accountId: income, dimensionKey: "", periodStart: "2026-01-01", amount: "1000" },
      { accountId: income, dimensionKey: "", periodStart: "2026-02-01", amount: "1,000" },
      { accountId: rent, dimensionKey: "", periodStart: "2026-01-01", amount: "300" },
    ]);
    await rejectsWith(saveBudgetCells(o.ctx, b.id, [{ accountId: income, dimensionKey: "", periodStart: "2026-03-01", amount: "1.005" }]), "validation_failed");
    const r = await budgetVsActual(getDb(), o.ctx.org, { budgetId: b.id, from: "2026-01-01", to: "2026-02-28", basis: "accrual" });
    const inc = r.rows.find((x) => x.accountId === income)!;
    expect(inc.budget.toFixed(2)).toBe("2000.00");
    expect(inc.actual.toFixed(2)).toBe("800.00");
    expect(inc.variance.toFixed(2)).toBe("-1200.00");
    expect(inc.variancePercent!.toString()).toBe("-60.0");
    expect(r.netBudget.toFixed(2)).toBe("1700.00");
    expect(r.netActual.toFixed(2)).toBe("800.00");
    const next = await createBudget(o.ctx, { name: "Plan 2027", fiscalYearStart: "2027-01-01", copyActuals: { basis: "accrual", adjustPercent: "10" } });
    const { lines } = await getBudget(getDb(), o.orgId, next.id);
    expect(lines.map((l) => [l.periodStart, amt(l.amount)])).toEqual([["2027-01-01", "880.00"]]);
    const csv = parseCsv(toCsv(await buildReport(getDb(), o.ctx.org, "budget-vs-actual", { budget: b.id, from: "2026-01-01", to: "2026-02-28" })));
    expect(csv.find((row) => row[0] === "Net income")?.[3]).toBe("-900.0000");
  });
});
