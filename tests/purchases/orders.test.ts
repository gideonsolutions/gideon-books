import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { documentLines, documents } from "@/lib/db/schema/commerce";
import { poBillMatches } from "@/lib/db/schema/purchasing";
import { getDocument, issueDocument, saveDraft, voidDocument, inputFromDocument } from "@/lib/commerce/documents";
import { billFromPurchaseOrder } from "@/lib/purchases/orders";
import { closePurchaseOrder, receivePurchaseOrder, reverseReceipt } from "@/lib/purchases/receiving";
import { inventoryReconciliation } from "@/lib/inventory/valuation";
import { Decimal } from "@/lib/money/decimal";
import { balance, rejectsWith, setupOrg, stockItem, vendor, type TestOrg } from "../helpers";
import { createItem } from "@/lib/items/items";

let t: TestOrg;
beforeAll(async () => {
  t = await setupOrg();
});

async function po(vendorId: string, lines: { itemId?: string; quantity: string; unitPrice: string; accountId?: string; description?: string }[], date = "2026-04-01") {
  const d = await saveDraft(t.ctx, { kind: "purchase_order", contactId: vendorId, issueDate: date, lines });
  return issueDocument(t.ctx, d.id);
}

async function poLines(id: string) {
  return getDb().select().from(documentLines).where(eq(documentLines.documentId, id)).orderBy(documentLines.lineNo);
}

async function status(id: string) {
  const [d] = await getDb().select().from(documents).where(eq(documents.id, id));
  return d!.status;
}

async function reconciled(orgId: string) {
  const rec = await inventoryReconciliation(getDb(), orgId, "2099-12-31");
  expect(rec.difference).toBe("0.0000");
}

describe("purchase orders, receiving and three-way matching", () => {
  it("receives into stock against GRNI, then the bill clears GRNI and books the price variance", async () => {
    const v = await vendor(t.ctx, "Bolt Supplier");
    const bolt = await stockItem(t.ctx, "Bolt");
    const order = await po(v.id, [{ itemId: bolt.id, quantity: "100", unitPrice: "2.00" }]);
    expect(order.status).toBe("issued");
    expect(order.number).toMatch(/^PO-/);
    // Nothing posts for an order.
    expect(order.journalEntryId).toBeNull();
    const [line] = await poLines(order.id);
    await receivePurchaseOrder(t.ctx, order.id, { date: "2026-04-05", lines: [{ poLineId: line!.id, quantity: "60" }] });
    expect(await status(order.id)).toBe("partially_received");
    expect(await balance(t.orgId, await t.acct("goods_received_not_invoiced"))).toBe("-120.00");
    expect(await balance(t.orgId, await t.acct("inventory_asset"))).toBe("120.00");
    await receivePurchaseOrder(t.ctx, order.id, { date: "2026-04-06", lines: [{ poLineId: line!.id, quantity: "40" }] });
    expect(await status(order.id)).toBe("received");
    // Over-receipt is refused.
    await rejectsWith(receivePurchaseOrder(t.ctx, order.id, { date: "2026-04-07", lines: [{ poLineId: line!.id, quantity: "1" }] }), "over_receipt");
    // The vendor bills at 2.10: 10.00 of price variance.
    const draft = await billFromPurchaseOrder(t.ctx, order.id);
    const { doc, lines } = await getDocument(getDb(), t.orgId, draft.id);
    const input = inputFromDocument(doc, lines);
    await saveDraft(t.ctx, { ...input, issueDate: "2026-04-08", reference: "INV-77", lines: input.lines.map((l) => ({ ...l, unitPrice: "2.10" })) }, draft.id);
    const billed = await issueDocument(t.ctx, draft.id);
    expect(billed.total).toBe("210.0000");
    expect(await balance(t.orgId, await t.acct("goods_received_not_invoiced"))).toBe("0.00");
    expect(await balance(t.orgId, await t.acct("purchase_price_variance"))).toBe("10.00");
    expect(await balance(t.orgId, await t.acct("inventory_asset"))).toBe("200.00");
    expect(await balance(t.orgId, await t.acct("accounts_payable"))).toBe("-210.00");
    expect(await status(order.id)).toBe("closed");
    await reconciled(t.orgId);
  });

  it("refuses billing more than ordered unless confirmed, and receives with the bill what was not received", async () => {
    const v = await vendor(t.ctx, "Nut Supplier");
    const nut = await stockItem(t.ctx, "Nut");
    const order = await po(v.id, [{ itemId: nut.id, quantity: "10", unitPrice: "1.00" }]);
    const [line] = await poLines(order.id);
    await receivePurchaseOrder(t.ctx, order.id, { date: "2026-04-05", lines: [{ poLineId: line!.id, quantity: "4" }] });
    const over = await saveDraft(t.ctx, { kind: "bill", contactId: v.id, issueDate: "2026-04-09", lines: [{ itemId: nut.id, quantity: "12", unitPrice: "1.00", sourceLineId: line!.id }] });
    await rejectsWith(issueDocument(t.ctx, over.id), "over_billing");
    const ok = await issueDocument(t.ctx, over.id, { allowOverBilling: true });
    expect(ok.status).toBe("issued");
    const [after] = await poLines(order.id);
    // 4 matched to the receipt, 8 received with the bill.
    expect(Decimal.from(after!.receivedQuantity).normalize().toString()).toBe("12");
    expect(Decimal.from(after!.billedQuantity).normalize().toString()).toBe("12");
    const [m] = await getDb().select().from(poBillMatches).where(eq(poBillMatches.billId, ok.id));
    expect(Decimal.from(m!.matchedQuantity).normalize().toString()).toBe("4");
    expect(Decimal.from(m!.receivedWithBill).normalize().toString()).toBe("8");
    await reconciled(t.orgId);
    // Voiding the bill puts the order back: billed 0, received 4 (the receipt), GRNI restored.
    const grniBefore = await balance(t.orgId, await t.acct("goods_received_not_invoiced"));
    await voidDocument(t.ctx, ok.id, { date: "2026-04-10", reason: "Billed in error" });
    const [restored] = await poLines(order.id);
    expect(Decimal.from(restored!.billedQuantity).normalize().toString()).toBe("0");
    expect(Decimal.from(restored!.receivedQuantity).normalize().toString()).toBe("4");
    expect(Decimal.from(await balance(t.orgId, await t.acct("goods_received_not_invoiced"))).sub(grniBefore).toFixed(2)).toBe("-4.00");
    expect(await status(order.id)).toBe("partially_received");
    await reconciled(t.orgId);
  });

  it("reverses an unbilled receipt and refuses to edit an order in use", async () => {
    const v = await vendor(t.ctx, "Washer Supplier");
    const w = await stockItem(t.ctx, "Washer");
    const order = await po(v.id, [{ itemId: w.id, quantity: "5", unitPrice: "3.00" }]);
    const [line] = await poLines(order.id);
    const rcv = await receivePurchaseOrder(t.ctx, order.id, { date: "2026-04-11", lines: [{ poLineId: line!.id, quantity: "5" }] });
    const { doc, lines } = await getDocument(getDb(), t.orgId, order.id);
    await rejectsWith(saveDraft(t.ctx, inputFromDocument(doc, lines), order.id), "po_in_use");
    await reverseReceipt(t.ctx, rcv.id, { date: "2026-04-12", reason: "Wrong items delivered, sent back" });
    expect(await status(order.id)).toBe("issued");
    const [l2] = await poLines(order.id);
    expect(Decimal.from(l2!.receivedQuantity).normalize().toString()).toBe("0");
    await reconciled(t.orgId);
    await closePurchaseOrder(t.ctx, order.id, "Vendor cannot supply");
    expect(await status(order.id)).toBe("closed");
    await rejectsWith(receivePurchaseOrder(t.ctx, order.id, { date: "2026-04-13", lines: [{ poLineId: line!.id, quantity: "1" }] }), "po_not_open");
  });

  it("tracks received and billed quantities for non-stock lines without posting a receipt", async () => {
    const v = await vendor(t.ctx, "Service Supplier");
    const svc = await createItem(t.ctx, { kind: "service", name: "Installation" });
    const order = await po(v.id, [{ itemId: svc.id, quantity: "2", unitPrice: "100", accountId: await t.acct("6650") }]);
    const [line] = await poLines(order.id);
    const r = await receivePurchaseOrder(t.ctx, order.id, { date: "2026-04-14", lines: [{ poLineId: line!.id, quantity: "2" }] });
    expect(r.journalEntryId).toBeNull();
    const draft = await billFromPurchaseOrder(t.ctx, order.id);
    await issueDocument(t.ctx, draft.id);
    expect(await status(order.id)).toBe("closed");
    const [m] = await getDb().select().from(poBillMatches).where(and(eq(poBillMatches.poLineId, line!.id)));
    expect(Decimal.from(m!.grniValue).isZero()).toBe(true);
  });
});
