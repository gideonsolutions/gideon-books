import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { cashBasisLines, documents } from "@/lib/db/schema/commerce";
import { issueDocument, saveDraft, voidDocument, writeOffInvoice, getDocument } from "@/lib/commerce/documents";
import { recordPayment, voidPayment, applyCredit } from "@/lib/commerce/payments";
import { itemBalance, openItemsForContact } from "@/lib/commerce/open-items";
import { createJurisdiction, addTaxRate, saveTaxCode } from "@/lib/tax/config";
import { addManualRate } from "@/lib/fx/rates";
import { Decimal } from "@/lib/money/decimal";
import { balance, customer, rejectsWith, setupOrg, stockItem, vendor, type TestOrg } from "../helpers";
import { inventoryReconciliation } from "@/lib/inventory/valuation";

let t: TestOrg;
beforeAll(async () => {
  t = await setupOrg();
});

async function invoice(contactId: string, lines: { unitPrice: string; quantity?: string; taxCodeId?: string; itemId?: string; accountId?: string }[], extra: Record<string, unknown> = {}) {
  const d = await saveDraft(t.ctx, { kind: "invoice", contactId, issueDate: "2026-02-01", lines: lines.map((l) => ({ quantity: "1", ...l })), ...extra });
  return issueDocument(t.ctx, d.id);
}

/** The receivables subledger (open items) equals the receivables account. */
async function assertArTiesOut(orgId: string, ar: string) {
  const r = await getDb().execute<{ s: string }>(sql`
    select coalesce(sum(l.base_amount), 0)::text as s from journal_lines l
    join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
    where l.org_id = ${orgId} and l.account_id = ${ar} and e.status = 'posted' and l.open_item_id is not null`);
  expect(Decimal.from(r.rows[0]!.s).toFixed(2)).toBe(await balance(orgId, ar));
}

describe("receivables", () => {
  it("issues an invoice with tax and posts receivable, income and tax", async () => {
    const c = await customer(t.ctx, "Taxed Customer");
    const j = await createJurisdiction(t.ctx, { name: "North Carolina" });
    await addTaxRate(t.ctx, { jurisdictionId: j.id, name: "NC state", rate: "4.75", effectiveFrom: "2020-01-01" });
    const code = await saveTaxCode(t.ctx, { name: "NC", components: [{ jurisdictionId: j.id }] });
    const inv = await invoice(c.id, [{ unitPrice: "100.00", taxCodeId: code.id }]);
    expect(inv.status).toBe("issued");
    expect(inv.number).toMatch(/^INV-\d{4}$/);
    expect(inv.total).toBe("104.7500");
    expect(await balance(t.orgId, await t.acct("accounts_receivable"))).toBe("104.75");
    expect(await balance(t.orgId, await t.acct("sales_tax_payable"))).toBe("-4.75");
    const { taxes } = await getDocument(getDb(), t.orgId, inv.id);
    expect(taxes[0]!.rate).toBe("0.04750000");
  });

  it("refuses a tax code with no rate in effect on the document date (no silent current rate)", async () => {
    const c = await customer(t.ctx, "Old Customer");
    const j = await createJurisdiction(t.ctx, { name: "Newtown" });
    await addTaxRate(t.ctx, { jurisdictionId: j.id, name: "Newtown 2026", rate: "1", effectiveFrom: "2026-06-01" });
    const code = await saveTaxCode(t.ctx, { name: "Newtown", components: [{ jurisdictionId: j.id }] });
    await rejectsWith(saveDraft(t.ctx, { kind: "invoice", contactId: c.id, issueDate: "2026-02-01", lines: [{ unitPrice: "10", taxCodeId: code.id }] }), "validation_failed");
  });

  it("takes partial payments, one payment across several invoices, and ties out to the ledger", async () => {
    const c = await customer(t.ctx, "Partial Payer");
    const a = await invoice(c.id, [{ unitPrice: "300" }]);
    const b = await invoice(c.id, [{ unitPrice: "200" }]);
    await recordPayment(t.ctx, {
      kind: "customer_payment",
      contactId: c.id,
      paymentDate: "2026-02-10",
      accountId: await t.acct("1000"),
      amount: "100",
      allocations: [{ itemType: "document", itemId: a.id, amount: "100" }],
    });
    let [docA] = await getDb().select().from(documents).where(eq(documents.id, a.id));
    expect(docA!.status).toBe("partially_paid");
    await recordPayment(t.ctx, {
      kind: "customer_payment",
      contactId: c.id,
      paymentDate: "2026-02-12",
      accountId: await t.acct("1000"),
      amount: "450",
      allocations: [
        { itemType: "document", itemId: a.id, amount: "200" },
        { itemType: "document", itemId: b.id, amount: "200" },
      ],
    });
    [docA] = await getDb().select().from(documents).where(eq(documents.id, a.id));
    expect(docA!.status).toBe("paid");
    const open = await openItemsForContact(getDb(), t.orgId, "receivables", c.id);
    // 50 unapplied credit remains.
    expect(open.map((o) => [o.kind, o.openTxn])).toEqual([["customer_payment", "50.0000"]]);
    await assertArTiesOut(t.orgId, await t.acct("accounts_receivable"));
  });

  it("refuses over-application, even concurrently", async () => {
    const c = await customer(t.ctx, "Racer");
    const inv = await invoice(c.id, [{ unitPrice: "100" }]);
    const bank = await t.acct("1000");
    const pay = () =>
      recordPayment(t.ctx, {
        kind: "customer_payment",
        contactId: c.id,
        paymentDate: "2026-02-15",
        accountId: bank,
        amount: "80",
        allocations: [{ itemType: "document", itemId: inv.id, amount: "80" }],
      });
    const results = await Promise.allSettled([pay(), pay(), pay()]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    const bal = await itemBalance(getDb(), t.orgId, inv.id);
    expect(bal.txn.toFixed(2)).toBe("20.00");
  });

  it("applies credit notes and deposits, refunds a credit, and writes off the rest", async () => {
    const c = await customer(t.ctx, "Credit Customer");
    const inv = await invoice(c.id, [{ unitPrice: "500" }]);
    const cnDraft = await saveDraft(t.ctx, { kind: "credit_note", contactId: c.id, issueDate: "2026-02-03", lines: [{ unitPrice: "50" }] });
    const cn = await issueDocument(t.ctx, cnDraft.id);
    await applyCredit(t.ctx, { debit: { type: "document", id: inv.id }, credit: { type: "document", id: cn.id }, amount: "50", date: "2026-02-03" });
    const dep = await recordPayment(t.ctx, { kind: "customer_deposit", contactId: c.id, paymentDate: "2026-01-20", accountId: await t.acct("1000"), amount: "100" });
    expect(await balance(t.orgId, await t.acct("customer_deposits"))).toBe("-100.00");
    await applyCredit(t.ctx, { debit: { type: "document", id: inv.id }, credit: { type: "payment", id: dep.id }, amount: "100", date: "2026-02-05" });
    expect(await balance(t.orgId, await t.acct("customer_deposits"))).toBe("0.00");
    // Overpay by 30, then refund it.
    const over = await recordPayment(t.ctx, {
      kind: "customer_payment",
      contactId: c.id,
      paymentDate: "2026-02-06",
      accountId: await t.acct("1000"),
      amount: "330",
      allocations: [{ itemType: "document", itemId: inv.id, amount: "300" }],
    });
    await recordPayment(t.ctx, {
      kind: "customer_refund",
      contactId: c.id,
      paymentDate: "2026-02-07",
      accountId: await t.acct("1000"),
      amount: "30",
      allocations: [{ itemType: "payment", itemId: over.id, amount: "30" }],
    });
    // 50 left on the invoice: write it off.
    await writeOffInvoice(t.ctx, inv.id, { date: "2026-02-20", reason: "Customer closed" });
    const bal = await itemBalance(getDb(), t.orgId, inv.id);
    expect(bal.txn.isZero()).toBe(true);
    expect(await balance(t.orgId, await t.acct("bad_debt"))).toBe("50.00");
    await assertArTiesOut(t.orgId, await t.acct("accounts_receivable"));
  });

  it("records processor fees separately from gross receipts", async () => {
    const c = await customer(t.ctx, "Card Customer");
    const inv = await invoice(c.id, [{ unitPrice: "100" }]);
    const clearing = await t.acct("payment_clearing");
    const before = await balance(t.orgId, clearing);
    await recordPayment(t.ctx, {
      kind: "customer_payment",
      contactId: c.id,
      paymentDate: "2026-02-08",
      accountId: clearing,
      amount: "100",
      feeAmount: "3.20",
      method: "card",
      allocations: [{ itemType: "document", itemId: inv.id, amount: "100" }],
    });
    expect(Decimal.from(await balance(t.orgId, clearing)).sub(before).toFixed(2)).toBe("96.80");
    expect(await balance(t.orgId, await t.acct("payment_fees"))).toBe("3.20");
  });

  it("voids only unpaid invoices, reversing on the void date", async () => {
    const c = await customer(t.ctx, "Void Customer");
    const inv = await invoice(c.id, [{ unitPrice: "40" }]);
    const p = await recordPayment(t.ctx, { kind: "customer_payment", contactId: c.id, paymentDate: "2026-02-09", accountId: await t.acct("1000"), amount: "40", allocations: [{ itemType: "document", itemId: inv.id, amount: "40" }] });
    await rejectsWith(voidDocument(t.ctx, inv.id, { date: "2026-02-10", reason: "wrong customer" }), "has_settlements");
    await voidPayment(t.ctx, p.id, { date: "2026-02-10", reason: "bounced" });
    const v = await voidDocument(t.ctx, inv.id, { date: "2026-02-10", reason: "wrong customer" });
    expect(v.status).toBe("void");
    expect((await itemBalance(getDb(), t.orgId, inv.id)).txn.isZero()).toBe(true);
    await assertArTiesOut(t.orgId, await t.acct("accounts_receivable"));
  });
});

describe("foreign currency", () => {
  it("books realized exchange differences on settlement and keeps history fixed", async () => {
    const o = await setupOrg();
    const c = await customer(o.ctx, "Euro Customer", { currency: "EUR" });
    await addManualRate(o.ctx, { currency: "EUR", rateDate: "2026-03-01", rate: "1.10" });
    await addManualRate(o.ctx, { currency: "EUR", rateDate: "2026-03-20", rate: "1.05" });
    const d = await saveDraft(o.ctx, { kind: "invoice", contactId: c.id, issueDate: "2026-03-01", lines: [{ unitPrice: "1000" }] });
    const inv = await issueDocument(o.ctx, d.id);
    expect(inv.currency).toBe("EUR");
    expect(inv.baseTotal).toBe("1100.0000");
    await recordPayment(o.ctx, {
      kind: "customer_payment",
      contactId: c.id,
      paymentDate: "2026-03-20",
      accountId: await o.acct("1000"),
      currency: "EUR",
      amount: "1000",
      accountAmount: "1050.00",
      allocations: [{ itemType: "document", itemId: inv.id, amount: "1000" }],
    });
    // Received 1,050 for a receivable carried at 1,100: a 50 realized loss.
    expect(await balance(o.orgId, await o.acct("realized_fx"))).toBe("50.00");
    expect(await balance(o.orgId, await o.acct("accounts_receivable"))).toBe("0.00");
    // Updating rates later never changes the posted invoice.
    await addManualRate(o.ctx, { currency: "EUR", rateDate: "2026-03-01", rate: "1.20" }).catch(() => {});
    const [after] = await getDb().select().from(documents).where(eq(documents.id, inv.id));
    expect(after!.baseTotal).toBe("1100.0000");
  });
});

describe("cash basis projection", () => {
  it("recognizes document lines pro rata as they are settled, and exactly in total", async () => {
    const o = await setupOrg();
    const c = await customer(o.ctx, "Cash Basis Customer");
    const d = await saveDraft(o.ctx, {
      kind: "invoice",
      contactId: c.id,
      issueDate: "2026-04-01",
      lines: [
        { unitPrice: "100.00", accountId: await o.acct("4100") },
        { unitPrice: "50.00", accountId: await o.acct("4900") },
      ],
    });
    const inv = await issueDocument(o.ctx, d.id);
    for (const [date, amt] of [["2026-04-10", "33.33"], ["2026-05-10", "33.33"], ["2026-06-10", "83.34"]] as const) {
      await recordPayment(o.ctx, { kind: "customer_payment", contactId: c.id, paymentDate: date, accountId: await o.acct("1000"), amount: amt, allocations: [{ itemType: "document", itemId: inv.id, amount: amt }] });
    }
    const rows = await getDb().select().from(cashBasisLines).where(and(eq(cashBasisLines.orgId, o.orgId), eq(cashBasisLines.sourceEntryId, inv.journalEntryId!)));
    const byAccount = new Map<string, Decimal>();
    for (const r of rows) byAccount.set(r.accountId, (byAccount.get(r.accountId) ?? Decimal.ZERO).add(r.baseAmount));
    expect(byAccount.get(await o.acct("4100"))!.toFixed(2)).toBe("-100.00");
    expect(byAccount.get(await o.acct("4900"))!.toFixed(2)).toBe("-50.00");
    const april = rows.filter((r) => r.entryDate === "2026-04-10");
    expect(Decimal.sum(april.map((r) => r.baseAmount)).toFixed(2)).toBe("-33.33");
  });
});

describe("inventory through documents", () => {
  it("receives on bills at cost, relieves average cost on invoices, and reconciles to the ledger", async () => {
    const o = await setupOrg();
    const v = await vendor(o.ctx, "Parts Vendor");
    const c = await customer(o.ctx, "Parts Customer");
    const widget = await stockItem(o.ctx, "Widget");
    const b1 = await saveDraft(o.ctx, { kind: "bill", contactId: v.id, issueDate: "2026-05-01", reference: "V-1", lines: [{ itemId: widget.id, quantity: "10", unitPrice: "4.00" }] });
    await issueDocument(o.ctx, b1.id);
    const b2 = await saveDraft(o.ctx, { kind: "bill", contactId: v.id, issueDate: "2026-05-02", reference: "V-2", lines: [{ itemId: widget.id, quantity: "5", unitPrice: "7.00" }] });
    await issueDocument(o.ctx, b2.id);
    // Average = (40 + 35) / 15 = 5.00
    const inv = await saveDraft(o.ctx, { kind: "invoice", contactId: c.id, issueDate: "2026-05-03", lines: [{ itemId: widget.id, quantity: "6", unitPrice: "12" }] });
    await issueDocument(o.ctx, inv.id);
    expect(await balance(o.orgId, await o.acct("cost_of_goods_sold"))).toBe("30.00");
    expect(await balance(o.orgId, await o.acct("inventory_asset"))).toBe("45.00");
    const rec = await inventoryReconciliation(getDb(), o.orgId, "2026-12-31");
    expect(rec.difference).toBe("0.0000");
    // Selling more than is on hand is refused.
    const tooMany = await saveDraft(o.ctx, { kind: "invoice", contactId: c.id, issueDate: "2026-05-04", lines: [{ itemId: widget.id, quantity: "10", unitPrice: "12" }] });
    await rejectsWith(issueDocument(o.ctx, tooMany.id), "insufficient_stock");
    // Backdating before the latest movement is refused.
    const back = await saveDraft(o.ctx, { kind: "invoice", contactId: c.id, issueDate: "2026-04-30", lines: [{ itemId: widget.id, quantity: "1", unitPrice: "12" }] });
    await rejectsWith(issueDocument(o.ctx, back.id), "stock_backdated");
  });
});
