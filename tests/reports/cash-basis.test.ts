/**
 * The cash-basis policy (docs/accounting/cash-basis.md), scenario by
 * scenario, with the expected figures worked out by hand. Every scenario also
 * checks that the cash-basis ledger balances entry by entry.
 */
import { describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { recordPayment, applyCredit } from "@/lib/commerce/payments";
import { writeOffInvoice } from "@/lib/commerce/documents";
import { createJurisdiction, addTaxRate, saveTaxCode } from "@/lib/tax/config";
import { addManualRate } from "@/lib/fx/rates";
import { createAccount } from "@/lib/ledger/accounts";
import { balanceSheet, profitAndLoss, trialBalance } from "@/lib/reports/statements";
import { ledgerTotal, unbalancedEntries } from "@/lib/reports/ledger";
import type { Basis } from "@/lib/reports/scope";
import type { Ctx } from "@/lib/context";
import { customer, setupOrg, stockItem, vendor, type TestOrg } from "../helpers";
import { doc } from "./helpers";

async function pl(o: TestOrg, from: string, to: string, basis: Basis) {
  return profitAndLoss(getDb(), o.ctx.org, { from, to, basis });
}
async function bs(o: TestOrg, asOf: string, basis: Basis) {
  return balanceSheet(getDb(), o.ctx.org, { asOf, basis });
}
const fig = (m: Map<string, { toFixed: (n: number) => string }[]>, id: string) => (m.get(id)?.[0]?.toFixed(2) ?? "0.00");

async function assertBalanced(o: TestOrg) {
  expect(await unbalancedEntries(getDb(), o.orgId, "cash")).toEqual([]);
  expect((await ledgerTotal(getDb(), o.orgId, "cash")).isZero()).toBe(true);
  for (const asOf of ["2026-01-31", "2026-03-31", "2026-06-30", "2026-12-31"]) {
    const tb = await trialBalance(getDb(), o.ctx.org, { asOf, basis: "cash" });
    expect(tb.totalDebit.eq(tb.totalCredit), `cash TB ${asOf}`).toBe(true);
    const b = await bs(o, asOf, "cash");
    expect(b.difference[0]!.isZero(), `cash BS ${asOf}`).toBe(true);
  }
}

async function taxCode(ctx: Ctx) {
  const j = await createJurisdiction(ctx, { name: "State" });
  await addTaxRate(ctx, { jurisdictionId: j.id, name: "State 10%", rate: "10", effectiveFrom: "2020-01-01" });
  return saveTaxCode(ctx, { name: "ST", components: [{ jurisdictionId: j.id }] });
}

describe("cash basis", () => {
  it("recognizes a taxed invoice in proportion to each payment, on the payment date", async () => {
    const o = await setupOrg();
    const code = await taxCode(o.ctx);
    const c = await customer(o.ctx);
    const inv = await doc(o.ctx, "invoice", c.id, "2026-01-10", [{ unitPrice: "1000", accountId: await o.acct("4100"), taxCodeId: code.id }]);
    const bank = await o.acct("1000");
    await recordPayment(o.ctx, { kind: "customer_payment", contactId: c.id, paymentDate: "2026-01-20", accountId: bank, amount: "440", allocations: [{ itemType: "document", itemId: inv.id, amount: "440" }] });
    await recordPayment(o.ctx, { kind: "customer_payment", contactId: c.id, paymentDate: "2026-02-15", accountId: bank, amount: "660", allocations: [{ itemType: "document", itemId: inv.id, amount: "660" }] });
    const income = await o.acct("4100");
    const tax = await o.acct("sales_tax_payable");
    const ar = await o.acct("accounts_receivable");
    // Accrual: all of it in January.
    expect(fig((await pl(o, "2026-01-01", "2026-01-31", "accrual")).byAccount, income)).toBe("1000.00");
    // Cash: 440 of 1,100 paid in January → 400 income, 40 tax; the rest in February.
    expect(fig((await pl(o, "2026-01-01", "2026-01-31", "cash")).byAccount, income)).toBe("400.00");
    expect(fig((await pl(o, "2026-02-01", "2026-02-28", "cash")).byAccount, income)).toBe("600.00");
    const jan = await bs(o, "2026-01-31", "cash");
    expect(fig(jan.byAccount, tax)).toBe("40.00");
    expect(fig(jan.byAccount, ar)).toBe("0.00");
    expect(fig(jan.byAccount, bank)).toBe("440.00");
    const janAccrual = await bs(o, "2026-01-31", "accrual");
    expect(fig(janAccrual.byAccount, ar)).toBe("660.00");
    expect(fig(janAccrual.byAccount, tax)).toBe("100.00");
    expect(fig((await bs(o, "2026-02-28", "cash")).byAccount, tax)).toBe("100.00");
    await assertBalanced(o);
  });

  it("keeps a deposit on the balance sheet until it is applied to the invoice", async () => {
    const o = await setupOrg();
    const c = await customer(o.ctx);
    const dep = await recordPayment(o.ctx, { kind: "customer_deposit", contactId: c.id, paymentDate: "2026-01-05", accountId: await o.acct("1000"), amount: "300" });
    const inv = await doc(o.ctx, "invoice", c.id, "2026-02-01", [{ unitPrice: "300", accountId: await o.acct("4100") }]);
    await applyCredit(o.ctx, { debit: { type: "document", id: inv.id }, credit: { type: "payment", id: dep.id }, amount: "300", date: "2026-02-01" });
    const income = await o.acct("4100");
    const deposits = await o.acct("customer_deposits");
    expect(fig((await pl(o, "2026-01-01", "2026-01-31", "cash")).byAccount, income)).toBe("0.00");
    expect(fig((await bs(o, "2026-01-31", "cash")).byAccount, deposits)).toBe("300.00");
    expect(fig((await pl(o, "2026-02-01", "2026-02-28", "cash")).byAccount, income)).toBe("300.00");
    expect(fig((await bs(o, "2026-02-28", "cash")).byAccount, deposits)).toBe("0.00");
    await assertBalanced(o);
  });

  it("does not recognize credits, write-offs or the share of an invoice they settle", async () => {
    const o = await setupOrg();
    const c = await customer(o.ctx);
    const returns = await createAccount(o.ctx, { code: "4050", name: "Sales Returns", subtype: "operating_income" });
    const income = await o.acct("4100");
    const badDebt = await o.acct("bad_debt");
    const invC = await doc(o.ctx, "invoice", c.id, "2026-03-01", [{ unitPrice: "500", accountId: income }]);
    const cn = await doc(o.ctx, "credit_note", c.id, "2026-03-05", [{ unitPrice: "100", accountId: returns.id }]);
    await applyCredit(o.ctx, { debit: { type: "document", id: invC.id }, credit: { type: "document", id: cn.id }, amount: "100", date: "2026-03-05" });
    await recordPayment(o.ctx, { kind: "customer_payment", contactId: c.id, paymentDate: "2026-03-20", accountId: await o.acct("1000"), amount: "400", allocations: [{ itemType: "document", itemId: invC.id, amount: "400" }] });
    const invD = await doc(o.ctx, "invoice", c.id, "2026-03-10", [{ unitPrice: "200", accountId: income }]);
    await writeOffInvoice(o.ctx, invD.id, { date: "2026-03-31", reason: "Customer went out of business" });
    const accrual = await pl(o, "2026-03-01", "2026-03-31", "accrual");
    expect(fig(accrual.byAccount, income)).toBe("700.00");
    expect(fig(accrual.byAccount, returns.id)).toBe("-100.00");
    expect(fig(accrual.byAccount, badDebt)).toBe("200.00");
    expect(accrual.netIncome[0]!.toFixed(2)).toBe("400.00");
    const cash = await pl(o, "2026-03-01", "2026-03-31", "cash");
    // Only the 400 the customer paid is income on the cash basis.
    expect(fig(cash.byAccount, income)).toBe("400.00");
    expect(fig(cash.byAccount, returns.id)).toBe("0.00");
    expect(fig(cash.byAccount, badDebt)).toBe("0.00");
    expect(cash.netIncome[0]!.toFixed(2)).toBe("400.00");
    await assertBalanced(o);
  });

  it("leaves an unapplied overpayment as a customer credit", async () => {
    const o = await setupOrg();
    const c = await customer(o.ctx);
    const inv = await doc(o.ctx, "invoice", c.id, "2026-04-01", [{ unitPrice: "100", accountId: await o.acct("4100") }]);
    await recordPayment(o.ctx, { kind: "customer_payment", contactId: c.id, paymentDate: "2026-04-02", accountId: await o.acct("1000"), amount: "150", allocations: [{ itemType: "document", itemId: inv.id, amount: "100" }] });
    expect(fig((await pl(o, "2026-04-01", "2026-04-30", "cash")).byAccount, await o.acct("4100"))).toBe("100.00");
    const b = await bs(o, "2026-04-30", "cash");
    expect(fig(b.byAccount, await o.acct("accounts_receivable"))).toBe("-50.00");
    expect(fig(b.byAccount, await o.acct("1000"))).toBe("150.00");
    await assertBalanced(o);
  });

  it("recognizes a foreign invoice at its own rate, with the realized difference", async () => {
    const o = await setupOrg();
    const c = await customer(o.ctx, "Euro Buyer", { currency: "EUR" });
    await addManualRate(o.ctx, { currency: "EUR", rateDate: "2026-05-01", rate: "1.10" });
    await addManualRate(o.ctx, { currency: "EUR", rateDate: "2026-05-20", rate: "1.05" });
    const inv = await doc(o.ctx, "invoice", c.id, "2026-05-01", [{ unitPrice: "1000", accountId: await o.acct("4100") }]);
    await recordPayment(o.ctx, { kind: "customer_payment", contactId: c.id, paymentDate: "2026-05-20", accountId: await o.acct("1000"), currency: "EUR", amount: "1000", accountAmount: "1050", allocations: [{ itemType: "document", itemId: inv.id, amount: "1000" }] });
    const cash = await pl(o, "2026-05-01", "2026-05-31", "cash");
    expect(fig(cash.byAccount, await o.acct("4100"))).toBe("1100.00");
    expect(fig(cash.byAccount, await o.acct("realized_fx"))).toBe("50.00");
    expect(cash.netIncome[0]!.toFixed(2)).toBe("1050.00");
    expect(fig((await pl(o, "2026-04-01", "2026-04-30", "cash")).byAccount, await o.acct("4100"))).toBe("0.00");
    await assertBalanced(o);
  });

  it("records inventory movements as they happen and the purchase when the bill is paid", async () => {
    const o = await setupOrg();
    const v = await vendor(o.ctx);
    const c = await customer(o.ctx);
    const w = await stockItem(o.ctx, "Widget", { salePrice: "25" });
    const bill = await doc(o.ctx, "bill", v.id, "2026-06-05", [{ itemId: w.id, quantity: "10", unitPrice: "10" }], { reference: "V-100" });
    const inv = await doc(o.ctx, "invoice", c.id, "2026-06-10", [{ itemId: w.id, quantity: "4", unitPrice: "25" }]);
    const bank = await o.acct("1000");
    await recordPayment(o.ctx, { kind: "customer_payment", contactId: c.id, paymentDate: "2026-06-12", accountId: bank, amount: "100", allocations: [{ itemType: "document", itemId: inv.id, amount: "100" }] });
    const inventory = await o.acct("inventory_asset");
    const june = await pl(o, "2026-06-01", "2026-06-30", "cash");
    expect(fig(june.byAccount, await o.acct("cost_of_goods_sold"))).toBe("40.00");
    expect(june.netIncome[0]!.toFixed(2)).toBe("60.00");
    expect(fig((await bs(o, "2026-06-30", "cash")).byAccount, inventory)).toBe("-40.00");
    expect(fig((await bs(o, "2026-06-30", "accrual")).byAccount, inventory)).toBe("60.00");
    await recordPayment(o.ctx, { kind: "vendor_payment", contactId: v.id, paymentDate: "2026-07-01", accountId: bank, amount: "100", allocations: [{ itemType: "document", itemId: bill.id, amount: "100" }] });
    const july = await bs(o, "2026-07-31", "cash");
    expect(fig(july.byAccount, inventory)).toBe("60.00");
    expect(fig(july.byAccount, bank)).toBe("0.00");
    await assertBalanced(o);
  });

  it("an unapplied settlement is undone on the cash basis on the date it is removed", async () => {
    const o = await setupOrg();
    const c = await customer(o.ctx);
    const inv = await doc(o.ctx, "invoice", c.id, "2026-08-01", [{ unitPrice: "100", accountId: await o.acct("4100") }]);
    const p = await recordPayment(o.ctx, { kind: "customer_payment", contactId: c.id, paymentDate: "2026-08-05", accountId: await o.acct("1000"), amount: "100", allocations: [{ itemType: "document", itemId: inv.id, amount: "100" }] });
    const { voidPayment } = await import("@/lib/commerce/payments");
    await voidPayment(o.ctx, p.id, { date: "2026-09-02", reason: "Bounced" });
    expect(fig((await pl(o, "2026-08-01", "2026-08-31", "cash")).byAccount, await o.acct("4100"))).toBe("100.00");
    expect(fig((await pl(o, "2026-09-01", "2026-09-30", "cash")).byAccount, await o.acct("4100"))).toBe("-100.00");
    await assertBalanced(o);
  });
});
