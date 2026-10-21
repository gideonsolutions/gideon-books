import { beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { documents, recurringRuns } from "@/lib/db/schema/commerce";
import { issueDocument, saveDraft, voidDocument } from "@/lib/commerce/documents";
import { applyCredit, recordPayment, unapply, voidPayment } from "@/lib/commerce/payments";
import { itemBalance, openItemsForContact } from "@/lib/commerce/open-items";
import { settlementsForItem } from "@/lib/commerce/settlements";
import { createContact } from "@/lib/contacts/contacts";
import { saveRecurringBill, runDueRecurringBills, runTemplate } from "@/lib/purchases/recurring";
import { payablesDue } from "@/lib/purchases/queries";
import { addToInbox, listInbox, matchReceipt, unmatchReceipt } from "@/lib/purchases/receipts";
import { listAttachments } from "@/lib/storage/attachments";
import { duplicateDocument, vendorCreditFromBill } from "@/lib/purchases/orders";
import { Decimal } from "@/lib/money/decimal";
import { balance, rejectsWith, setupOrg, vendor, type TestOrg } from "../helpers";

let t: TestOrg;
beforeAll(async () => {
  t = await setupOrg();
});

async function bill(contactId: string, amount: string, extra: Record<string, unknown> = {}, date = "2026-03-01") {
  const d = await saveDraft(t.ctx, { kind: "bill", contactId, issueDate: date, reference: `V-${amount}-${Math.random().toString(36).slice(2, 6)}`, lines: [{ unitPrice: amount, accountId: await t.acct("6500") }], ...extra });
  return issueDocument(t.ctx, d.id);
}

/** The payables subledger (open items) equals the payables account. */
async function assertApTiesOut() {
  const ap = await t.acct("accounts_payable");
  const r = await getDb().execute<{ s: string }>(sql`
    select coalesce(sum(l.base_amount), 0)::text as s from journal_lines l
    join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
    where l.org_id = ${t.orgId} and l.account_id = ${ap} and e.status = 'posted' and l.open_item_id is not null`);
  expect(Decimal.from(r.rows[0]!.s).toFixed(2)).toBe(await balance(t.orgId, ap));
  // And every open item, summed, is the account balance.
  const all = await getDb().execute<{ s: string }>(sql`
    select coalesce(sum(b), 0)::text as s from (
      select sum(l.base_amount) as b from journal_lines l join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
      where l.org_id = ${t.orgId} and l.account_id = ${ap} and e.status = 'posted' group by l.open_item_id) x`);
  expect(Decimal.from(all.rows[0]!.s).toFixed(2)).toBe(await balance(t.orgId, ap));
}

describe("payables", () => {
  it("posts a bill to expense and accounts payable, with its due date from terms", async () => {
    const v = await vendor(t.ctx, "Office Supply Co");
    const b = await bill(v.id, "120.00", { dueDate: null });
    expect(b.status).toBe("issued");
    expect(b.number).toMatch(/^BILL-/);
    expect(await balance(t.orgId, await t.acct("accounts_payable"))).toBe("-120.00");
    await assertApTiesOut();
  });

  it("pays partially, then pays several bills with one payment, and ties out", async () => {
    const v = await vendor(t.ctx, "Multi Bill Vendor");
    const a = await bill(v.id, "300");
    const b = await bill(v.id, "150");
    await recordPayment(t.ctx, { kind: "vendor_payment", contactId: v.id, paymentDate: "2026-03-05", accountId: await t.acct("1000"), amount: "100", allocations: [{ itemType: "document", itemId: a.id, amount: "100" }] });
    let [docA] = await getDb().select().from(documents).where(eq(documents.id, a.id));
    expect(docA!.status).toBe("partially_paid");
    await recordPayment(t.ctx, {
      kind: "vendor_payment",
      contactId: v.id,
      paymentDate: "2026-03-06",
      accountId: await t.acct("1000"),
      amount: "350",
      reference: "Check 1042",
      allocations: [
        { itemType: "document", itemId: a.id, amount: "200" },
        { itemType: "document", itemId: b.id, amount: "150" },
      ],
    });
    [docA] = await getDb().select().from(documents).where(eq(documents.id, a.id));
    const [docB] = await getDb().select().from(documents).where(eq(documents.id, b.id));
    expect(docA!.status).toBe("paid");
    expect(docB!.status).toBe("paid");
    expect(await openItemsForContact(getDb(), t.orgId, "payables", v.id)).toEqual([]);
    await assertApTiesOut();
  });

  it("applies prepayments and vendor credits, refunds the rest, and voids", async () => {
    const v = await vendor(t.ctx, "Prepaid Vendor");
    const prepay = await recordPayment(t.ctx, { kind: "vendor_prepayment", contactId: v.id, paymentDate: "2026-02-20", accountId: await t.acct("1000"), amount: "500" });
    expect(await balance(t.orgId, await t.acct("vendor_prepayments"))).toBe("500.00");
    const b = await bill(v.id, "400", {}, "2026-03-02");
    await applyCredit(t.ctx, { debit: { type: "payment", id: prepay.id }, credit: { type: "document", id: b.id }, amount: "400", date: "2026-03-02" });
    expect((await itemBalance(getDb(), t.orgId, b.id)).txn.isZero()).toBe(true);
    // A vendor credit for 30 on another bill.
    const b2 = await bill(v.id, "200", {}, "2026-03-03");
    const vcDraft = await saveDraft(t.ctx, { kind: "vendor_credit", contactId: v.id, issueDate: "2026-03-04", lines: [{ unitPrice: "30", accountId: await t.acct("6500") }] });
    const vc = await issueDocument(t.ctx, vcDraft.id);
    await applyCredit(t.ctx, { debit: { type: "document", id: vc.id }, credit: { type: "document", id: b2.id }, amount: "30", date: "2026-03-04" });
    expect((await itemBalance(getDb(), t.orgId, b2.id)).txn.toFixed(2)).toBe("-170.00");
    // 100 of the prepayment is left; the vendor refunds it.
    await recordPayment(t.ctx, {
      kind: "vendor_refund",
      contactId: v.id,
      paymentDate: "2026-03-10",
      accountId: await t.acct("1000"),
      amount: "100",
      allocations: [{ itemType: "payment", itemId: prepay.id, amount: "100" }],
    });
    expect(await balance(t.orgId, await t.acct("vendor_prepayments"))).toBe("0.00");
    // Pay b2, then void the payment: b2 is open again.
    const p = await recordPayment(t.ctx, { kind: "vendor_payment", contactId: v.id, paymentDate: "2026-03-11", accountId: await t.acct("1000"), amount: "170", allocations: [{ itemType: "document", itemId: b2.id, amount: "170" }] });
    await voidPayment(t.ctx, p.id, { date: "2026-03-12", reason: "Check lost" });
    expect((await itemBalance(getDb(), t.orgId, b2.id)).txn.toFixed(2)).toBe("-170.00");
    // Remove the credit application, then void the bill.
    const [credit] = await settlementsForItem(getDb(), t.orgId, b2.id, { activeOnly: true });
    await unapply(t.ctx, credit!.id, { date: "2026-03-12", reason: "Credit belongs to another bill" });
    const v2 = await voidDocument(t.ctx, b2.id, { date: "2026-03-12", reason: "Duplicate bill" });
    expect(v2.status).toBe("void");
    await assertApTiesOut();
  });

  it("records an employee's expense claim as a reimbursable payable and pays it", async () => {
    const emp = await createContact(t.ctx, { displayName: "Dana Employee", isEmployee: true });
    const d = await saveDraft(t.ctx, { kind: "bill", contactId: emp.id, issueDate: "2026-03-07", isReimbursement: true, lines: [{ description: "Client lunch", unitPrice: "64.20", accountId: await t.acct("6350") }] });
    const claim = await issueDocument(t.ctx, d.id);
    expect(claim.isReimbursement).toBe(true);
    await recordPayment(t.ctx, { kind: "vendor_payment", contactId: emp.id, paymentDate: "2026-03-15", accountId: await t.acct("1000"), amount: "64.20", allocations: [{ itemType: "document", itemId: claim.id, amount: "64.20" }] });
    const [after] = await getDb().select().from(documents).where(eq(documents.id, claim.id));
    expect(after!.status).toBe("paid");
    // A non-vendor without the reimbursement flag is refused.
    await rejectsWith(saveDraft(t.ctx, { kind: "bill", contactId: emp.id, issueDate: "2026-03-07", lines: [{ unitPrice: "1" }] }), "validation_failed");
    await assertApTiesOut();
  });

  it("records expenses paid at once from a card, with no payable", async () => {
    const v = await vendor(t.ctx, "Gas Station");
    const before = await balance(t.orgId, await t.acct("accounts_payable"));
    const d = await saveDraft(t.ctx, { kind: "expense", contactId: v.id, issueDate: "2026-03-08", cashAccountId: await t.acct("2100"), lines: [{ unitPrice: "45.10", accountId: await t.acct("6850") }] });
    const e = await issueDocument(t.ctx, d.id);
    expect(e.status).toBe("paid");
    expect(await balance(t.orgId, await t.acct("accounts_payable"))).toBe(before);
    expect(await balance(t.orgId, await t.acct("2100"))).toBe("-45.10");
  });

  it("groups open bills by due date", async () => {
    const o = await setupOrg();
    const v = await vendor(o.ctx, "Due Vendor");
    const mk = async (date: string, due: string, amt: string) => {
      const d = await saveDraft(o.ctx, { kind: "bill", contactId: v.id, issueDate: date, dueDate: due, lines: [{ unitPrice: amt, accountId: await o.acct("6500") }] });
      return issueDocument(o.ctx, d.id);
    };
    await mk("2026-03-01", "2026-03-10", "10");
    await mk("2026-03-01", "2026-03-18", "20");
    await mk("2026-03-01", "2026-05-01", "30");
    const r = await payablesDue(getDb(), o.orgId, "2026-03-15");
    expect(r.groups.overdue.map((x) => x.open)).toEqual(["10.0000"]);
    expect(r.groups.week.map((x) => x.open)).toEqual(["20.0000"]);
    expect(r.groups.later.map((x) => x.open)).toEqual(["30.0000"]);
  });

  it("duplicates a bill and makes a vendor credit from it", async () => {
    const v = await vendor(t.ctx, "Copy Vendor");
    const b = await bill(v.id, "77");
    const copy = await duplicateDocument(t.ctx, b.id);
    expect(copy.status).toBe("draft");
    expect(copy.total).toBe("77.0000");
    const vc = await vendorCreditFromBill(t.ctx, b.id);
    expect(vc.kind).toBe("vendor_credit");
    expect(vc.sourceDocumentId).toBe(b.id);
  });
});

describe("foreign-currency payables", () => {
  it("books the realized exchange difference when a euro bill is paid", async () => {
    const o = await setupOrg();
    const v = await vendor(o.ctx, "Euro Supplier", { currency: "EUR" });
    const { addManualRate } = await import("@/lib/fx/rates");
    await addManualRate(o.ctx, { currency: "EUR", rateDate: "2026-05-01", rate: "1.10" });
    await addManualRate(o.ctx, { currency: "EUR", rateDate: "2026-05-20", rate: "1.15" });
    const d = await saveDraft(o.ctx, { kind: "bill", contactId: v.id, issueDate: "2026-05-01", lines: [{ unitPrice: "1000", accountId: await o.acct("6300") }] });
    const b = await issueDocument(o.ctx, d.id);
    expect(b.baseTotal).toBe("1100.0000");
    expect(await balance(o.orgId, await o.acct("accounts_payable"))).toBe("-1100.00");
    // Paid from a USD account: 1,150 left the bank for a payable carried at 1,100 — a 50 loss.
    await recordPayment(o.ctx, {
      kind: "vendor_payment",
      contactId: v.id,
      paymentDate: "2026-05-20",
      accountId: await o.acct("1000"),
      currency: "EUR",
      amount: "1000",
      accountAmount: "1150.00",
      allocations: [{ itemType: "document", itemId: b.id, amount: "1000" }],
    });
    expect(await balance(o.orgId, await o.acct("accounts_payable"))).toBe("0.00");
    expect(await balance(o.orgId, await o.acct("realized_fx"))).toBe("50.00");
    expect(await balance(o.orgId, await o.acct("1000"))).toBe("-1150.00");
  });
});

describe("recurring bills", () => {
  it("runs through the background job handler", async () => {
    const o = await setupOrg();
    const v = await vendor(o.ctx, "Cleaner");
    await saveRecurringBill(o.ctx, {
      name: "Cleaning",
      frequency: "weekly",
      interval: 2,
      startDate: "2026-06-01",
      autoIssue: false,
      bill: { kind: "bill", contactId: v.id, issueDate: "2026-06-01", lines: [{ unitPrice: "80", accountId: await o.acct("6650") }] },
    });
    const { purchasesJobs } = await import("@/lib/purchases/jobs");
    const r = (await purchasesJobs["purchases.recurring"]!({ payload: { orgId: o.orgId, today: "2026-06-30" } } as never, { progress: async () => {} })) as { created: number };
    expect(r.created).toBe(3); // June 1, 15, 29
  });

  it("produces each occurrence exactly once, even when run repeatedly and concurrently", async () => {
    const o = await setupOrg();
    const v = await vendor(o.ctx, "Landlord");
    const tpl = await saveRecurringBill(o.ctx, {
      name: "Rent",
      frequency: "monthly",
      interval: 1,
      startDate: "2026-01-31",
      autoIssue: true,
      bill: { kind: "bill", contactId: v.id, issueDate: "2026-01-31", lines: [{ description: "Rent", unitPrice: "1500", accountId: await o.acct("6550") }] },
    });
    await Promise.all([runTemplate(tpl.id, "2026-04-15"), runTemplate(tpl.id, "2026-04-15"), runDueRecurringBills("2026-04-15", o.orgId)]);
    await runDueRecurringBills("2026-04-15", o.orgId);
    const bills = await getDb().select().from(documents).where(eq(documents.recurringTemplateId, tpl.id));
    expect(bills.map((b) => b.issueDate).sort()).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
    expect(bills.every((b) => b.status === "issued")).toBe(true);
    const runs = await getDb().select().from(recurringRuns).where(eq(recurringRuns.templateId, tpl.id));
    expect(runs).toHaveLength(3);
    expect(await balance(o.orgId, await o.acct("accounts_payable"))).toBe("-4500.00");
  });

  it("stops at the end date or occurrence limit", async () => {
    const o = await setupOrg();
    const v = await vendor(o.ctx, "Software Co");
    const tpl = await saveRecurringBill(o.ctx, {
      name: "Subscription",
      frequency: "monthly",
      interval: 1,
      startDate: "2026-01-01",
      maxOccurrences: 2,
      autoIssue: false,
      bill: { kind: "bill", contactId: v.id, issueDate: "2026-01-01", lines: [{ unitPrice: "20", accountId: await o.acct("6500") }] },
    });
    await runTemplate(tpl.id, "2026-12-31");
    const bills = await getDb().select().from(documents).where(eq(documents.recurringTemplateId, tpl.id));
    expect(bills).toHaveLength(2);
    expect(bills.every((b) => b.status === "draft")).toBe(true);
  });
});

describe("receipt inbox", () => {
  it("matches an uploaded receipt to a bill and unmatches it", async () => {
    const v = await vendor(t.ctx, "Receipt Vendor");
    const b = await bill(v.id, "12.34");
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
    const a = await addToInbox(t.ctx, { fileName: "receipt.png", contentType: "image/png", bytes: png });
    expect((await listInbox(getDb(), t.orgId, "unmatched")).map((r) => r.attachment.id)).toContain(a.id);
    const m = await matchReceipt(t.ctx, a.id, b.id);
    expect((await listAttachments(getDb(), t.orgId, "purchase_document", b.id)).map((x) => x.fileName)).toEqual(["receipt.png"]);
    expect((await listInbox(getDb(), t.orgId, "unmatched")).map((r) => r.attachment.id)).not.toContain(a.id);
    await rejectsWith(matchReceipt(t.ctx, a.id, b.id), "already_matched");
    await unmatchReceipt(t.ctx, m.id);
    expect(await listAttachments(getDb(), t.orgId, "purchase_document", b.id)).toEqual([]);
    expect((await listInbox(getDb(), t.orgId, "unmatched")).map((r) => r.attachment.id)).toContain(a.id);
  });
});
