import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { documents } from "@/lib/db/schema/commerce";
import { issueDocument, saveDraft, voidDocument, writeOffInvoice, listDocuments } from "@/lib/commerce/documents";
import { applyCredit, recordPayment, unapply, voidPayment } from "@/lib/commerce/payments";
import { displayStatus, isOverdue } from "@/lib/commerce/states";
import { itemBalance } from "@/lib/commerce/open-items";
import { documentDetail, duplicateDocument, openCreditsFor } from "@/lib/sales/documents";
import { Decimal } from "@/lib/money/decimal";
import { balance, customer, rejectsWith, setupOrg, type TestOrg } from "../helpers";

let t: TestOrg;
beforeAll(async () => {
  t = await setupOrg();
});

async function issued(contactId: string, price: string, extra: Record<string, unknown> = {}) {
  const d = await saveDraft(t.ctx, { kind: "invoice", contactId, issueDate: "2026-03-01", dueDate: "2026-03-31", lines: [{ unitPrice: price }], ...extra });
  return issueDocument(t.ctx, d.id);
}

async function status(id: string) {
  const [d] = await getDb().select().from(documents).where(eq(documents.id, id));
  return d!.status;
}

describe("invoice states", () => {
  it("moves draft → issued → partially paid → paid, and back when a payment is removed", async () => {
    const c = await customer(t.ctx, "Stateful");
    const draft = await saveDraft(t.ctx, { kind: "invoice", contactId: c.id, issueDate: "2026-03-01", lines: [{ unitPrice: "100" }] });
    expect(draft.status).toBe("draft");
    expect(draft.number).toBeNull();
    const inv = await issueDocument(t.ctx, draft.id);
    expect(inv.status).toBe("issued");
    await rejectsWith(issueDocument(t.ctx, draft.id), "not_draft");
    const bank = await t.acct("1000");
    const p1 = await recordPayment(t.ctx, { kind: "customer_payment", contactId: c.id, paymentDate: "2026-03-05", accountId: bank, amount: "40", allocations: [{ itemType: "document", itemId: inv.id, amount: "40" }] });
    expect(await status(inv.id)).toBe("partially_paid");
    await recordPayment(t.ctx, { kind: "customer_payment", contactId: c.id, paymentDate: "2026-03-06", accountId: bank, amount: "60", allocations: [{ itemType: "document", itemId: inv.id, amount: "60" }] });
    expect(await status(inv.id)).toBe("paid");
    await voidPayment(t.ctx, p1.id, { date: "2026-03-07", reason: "Bounced check" });
    expect(await status(inv.id)).toBe("partially_paid");
    expect((await itemBalance(getDb(), t.orgId, inv.id)).txn.toFixed(2)).toBe("40.00");
  });

  it("derives overdue from the due date without storing it", async () => {
    const c = await customer(t.ctx, "Late Payer");
    const inv = await issued(c.id, "50");
    expect(isOverdue(inv, "2026-03-31")).toBe(false);
    expect(isOverdue(inv, "2026-04-01")).toBe(true);
    expect(displayStatus(inv, "2026-04-01")).toBe("Overdue");
    const { rows } = await listDocuments(getDb(), t.orgId, { kind: "invoice", overdue: true, today: "2026-04-01", contactId: c.id });
    expect(rows.map((r) => r.doc.id)).toEqual([inv.id]);
    expect(rows[0]!.openAmount).toBe("50.0000");
  });

  it("voids only without applications; a void invoice stays void", async () => {
    const c = await customer(t.ctx, "Voider");
    const inv = await issued(c.id, "75");
    const p = await recordPayment(t.ctx, { kind: "customer_payment", contactId: c.id, paymentDate: "2026-03-02", accountId: await t.acct("1000"), amount: "75", allocations: [{ itemType: "document", itemId: inv.id, amount: "75" }] });
    await rejectsWith(voidDocument(t.ctx, inv.id, { date: "2026-03-03", reason: "Wrong customer" }), "has_settlements");
    const detail = await documentDetail(getDb(), t.orgId, inv.id);
    expect(detail.applications).toHaveLength(1);
    await unapply(t.ctx, detail.applications[0]!.settlement.id, { date: "2026-03-03", reason: "Applied to the wrong invoice" });
    expect(await status(inv.id)).toBe("issued");
    const v = await voidDocument(t.ctx, inv.id, { date: "2026-03-03", reason: "Wrong customer" });
    expect(v.status).toBe("void");
    await rejectsWith(voidDocument(t.ctx, inv.id, { date: "2026-03-04", reason: "again" }), "already_void");
    // The payment is now an unapplied credit the customer can use.
    const credits = await openCreditsFor(getDb(), t.ctx, c.id, "USD");
    expect(credits.map((x) => [x.id, x.openTxn])).toEqual([[p.id, "75.0000"]]);
  });

  it("applies deposits and credit notes, refunds overpayments, writes off the rest; AR ties to the ledger", async () => {
    const c = await customer(t.ctx, "Mixed Settler");
    const inv = await issued(c.id, "1000");
    const dep = await recordPayment(t.ctx, { kind: "customer_deposit", contactId: c.id, paymentDate: "2026-03-01", accountId: await t.acct("1000"), amount: "200" });
    await applyCredit(t.ctx, { debit: { type: "document", id: inv.id }, credit: { type: "payment", id: dep.id }, amount: "200", date: "2026-03-02" });
    const cn = await issueDocument(t.ctx, (await saveDraft(t.ctx, { kind: "credit_note", contactId: c.id, issueDate: "2026-03-03", lines: [{ unitPrice: "100" }] })).id);
    await applyCredit(t.ctx, { debit: { type: "document", id: inv.id }, credit: { type: "document", id: cn.id }, amount: "100", date: "2026-03-03" });
    const over = await recordPayment(t.ctx, { kind: "customer_payment", contactId: c.id, paymentDate: "2026-03-04", accountId: await t.acct("1000"), amount: "650", allocations: [{ itemType: "document", itemId: inv.id, amount: "600" }] });
    await recordPayment(t.ctx, { kind: "customer_refund", contactId: c.id, paymentDate: "2026-03-05", accountId: await t.acct("1000"), amount: "50", allocations: [{ itemType: "payment", itemId: over.id, amount: "50" }] });
    await writeOffInvoice(t.ctx, inv.id, { date: "2026-03-10", reason: "Disputed balance, settled" });
    expect(await status(inv.id)).toBe("paid");
    expect(await status(cn.id)).toBe("closed");
    const ar = await t.acct("accounts_receivable");
    const sub = await getDb().execute<{ s: string }>(sql`select coalesce(sum(l.base_amount),0)::text s from journal_lines l join journal_entries e on e.id = l.entry_id where l.org_id = ${t.orgId} and l.account_id = ${ar} and e.status = 'posted' and l.open_item_id is not null`);
    expect(Decimal.from(sub.rows[0]!.s).toFixed(2)).toBe(await balance(t.orgId, ar));
  });

  it("duplicates a document as a new draft", async () => {
    const c = await customer(t.ctx, "Repeat");
    const inv = await issued(c.id, "12.34");
    const copy = await duplicateDocument(t.ctx, inv.id);
    expect(copy.status).toBe("draft");
    expect(copy.total).toBe("12.3400");
    expect(copy.id).not.toBe(inv.id);
    const [orig] = await getDb().select().from(documents).where(and(eq(documents.id, inv.id)));
    expect(orig!.status).toBe("issued");
  });
});
