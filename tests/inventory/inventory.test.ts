import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb, withTransaction } from "@/lib/db/client";
import { itemCosts, stockMoves } from "@/lib/db/schema/inventory";
import { issueDocument, saveDraft, voidDocument } from "@/lib/commerce/documents";
import { issueStock, receiveStock, defaultLocationId } from "@/lib/inventory/stock";
import { recordMovement } from "@/lib/inventory/movements";
import { saveLocation } from "@/lib/inventory/locations";
import { stockOnHand, itemStockDetail, valuationAsOf } from "@/lib/inventory/queries";
import { inventoryReconciliation } from "@/lib/inventory/valuation";
import { Decimal } from "@/lib/money/decimal";
import { balance, customer, rejectsWith, setupOrg, stockItem, vendor, type TestOrg } from "../helpers";

async function reconciled(t: TestOrg) {
  const rec = await inventoryReconciliation(getDb(), t.orgId, "2099-12-31");
  expect(rec.difference).toBe("0.0000");
}

async function cost(orgId: string, itemId: string) {
  const [c] = await getDb().select().from(itemCosts).where(and(eq(itemCosts.orgId, orgId), eq(itemCosts.itemId, itemId)));
  return { qty: Decimal.from(c?.qtyOnHand ?? "0").normalize().toString(), value: Decimal.from(c?.totalValue ?? "0").toFixed(2) };
}

describe("inventory costing", () => {
  it("averages cost across receipts, rounds issues, and empties to exactly zero value", async () => {
    const t = await setupOrg();
    const item = await stockItem(t.ctx, "Gizmo");
    const main = await withTransaction((tx) => defaultLocationId(tx, t.ctx));
    await recordMovement(t.ctx, { kind: "opening", date: "2026-01-01", reason: "Opening count", locationId: main, lines: [{ itemId: item.id, quantity: "3", unitCost: "1.00" }] });
    // Receipts of 3 @ 1.00 and 4 @ 1.25 (bill) → 7 units, 8.00 value, average 1.142857…
    const v = await vendor(t.ctx);
    const b = await saveDraft(t.ctx, { kind: "bill", contactId: v.id, issueDate: "2026-01-02", lines: [{ itemId: item.id, quantity: "4", unitPrice: "1.25" }] });
    await issueDocument(t.ctx, b.id);
    expect(await cost(t.orgId, item.id)).toEqual({ qty: "7", value: "8.00" });
    // Issue 1: 8.00 × 1/7 = 1.142857 → 1.14
    const c = await customer(t.ctx);
    const inv = await saveDraft(t.ctx, { kind: "invoice", contactId: c.id, issueDate: "2026-01-03", lines: [{ itemId: item.id, quantity: "1", unitPrice: "5" }] });
    await issueDocument(t.ctx, inv.id);
    expect(await cost(t.orgId, item.id)).toEqual({ qty: "6", value: "6.86" });
    expect(await balance(t.orgId, await t.acct("cost_of_goods_sold"))).toBe("1.14");
    // Issue the remaining 6: takes all 6.86 — nothing is left behind.
    const inv2 = await saveDraft(t.ctx, { kind: "invoice", contactId: c.id, issueDate: "2026-01-04", lines: [{ itemId: item.id, quantity: "6", unitPrice: "5" }] });
    await issueDocument(t.ctx, inv2.id);
    expect(await cost(t.orgId, item.id)).toEqual({ qty: "0", value: "0.00" });
    expect(await balance(t.orgId, await t.acct("inventory_asset"))).toBe("0.00");
    await reconciled(t);
    // Opening stock went to opening balance equity.
    expect(await balance(t.orgId, await t.acct("opening_balance_equity"))).toBe("-3.00");
  });

  it("transfers keep value; adjustments post to inventory adjustments; revaluations change value only", async () => {
    const t = await setupOrg();
    const item = await stockItem(t.ctx, "Crate");
    const main = await withTransaction((tx) => defaultLocationId(tx, t.ctx));
    const van = await saveLocation(t.ctx, { code: "VAN", name: "Delivery van" });
    await recordMovement(t.ctx, { kind: "opening", date: "2026-02-01", reason: "Opening", locationId: main, lines: [{ itemId: item.id, quantity: "10", unitCost: "4.00" }] });
    const tr = await recordMovement(t.ctx, { kind: "transfer", date: "2026-02-02", reason: "Load van", locationId: main, toLocationId: van.id, lines: [{ itemId: item.id, quantity: "4" }] });
    expect(tr.journalEntryId).toBeNull();
    const detail = await itemStockDetail(getDb(), t.orgId, item.id);
    expect(detail.byLocation.map((l) => [l.code, Decimal.from(l.qty).normalize().toString()]).sort()).toEqual([
      ["MAIN", "6"],
      ["VAN", "4"],
    ]);
    expect(detail.totalValue).toBe("40.0000");
    // Two crates broken in the van.
    await recordMovement(t.ctx, { kind: "adjustment", date: "2026-02-03", reason: "Broken in transit", locationId: van.id, lines: [{ itemId: item.id, quantity: "-2" }] });
    expect(await balance(t.orgId, await t.acct("inventory_adjustments"))).toBe("8.00");
    // One found in the warehouse at average cost (4.00).
    await recordMovement(t.ctx, { kind: "adjustment", date: "2026-02-04", reason: "Count found one more", locationId: main, lines: [{ itemId: item.id, quantity: "1" }] });
    expect(await cost(t.orgId, item.id)).toEqual({ qty: "9", value: "36.00" });
    // Write down by 4.50.
    await recordMovement(t.ctx, { kind: "revaluation", date: "2026-02-05", reason: "Damaged packaging", locationId: main, lines: [{ itemId: item.id, valueChange: "-4.50" }] });
    expect(await cost(t.orgId, item.id)).toEqual({ qty: "9", value: "31.50" });
    expect(await balance(t.orgId, await t.acct("inventory_adjustments"))).toBe("8.50");
    await reconciled(t);
    const report = await stockOnHand(getDb(), t.orgId, {});
    expect(report[0]!.avgCost).toBe("3.5000");
    const asOf = await valuationAsOf(getDb(), t.orgId, "2026-02-03");
    expect(Decimal.from(asOf[0]!.value).toFixed(2)).toBe("32.00");
  });

  it("refuses negative stock, backdating, and transfers of stock not at the location", async () => {
    const t = await setupOrg();
    const item = await stockItem(t.ctx, "Valve");
    const main = await withTransaction((tx) => defaultLocationId(tx, t.ctx));
    const back = await saveLocation(t.ctx, { code: "BACK", name: "Back room" });
    await rejectsWith(recordMovement(t.ctx, { kind: "adjustment", date: "2026-03-01", reason: "Lost", locationId: main, lines: [{ itemId: item.id, quantity: "-1" }] }), "insufficient_stock");
    await recordMovement(t.ctx, { kind: "opening", date: "2026-03-05", reason: "Opening", locationId: main, lines: [{ itemId: item.id, quantity: "2", unitCost: "10" }] });
    await rejectsWith(recordMovement(t.ctx, { kind: "adjustment", date: "2026-03-04", reason: "Late count", locationId: main, lines: [{ itemId: item.id, quantity: "1", unitCost: "10" }] }), "stock_backdated");
    await rejectsWith(recordMovement(t.ctx, { kind: "transfer", date: "2026-03-06", reason: "Move", locationId: back.id, toLocationId: main, lines: [{ itemId: item.id, quantity: "1" }] }), "insufficient_stock");
    await rejectsWith(saveLocation(t.ctx, { id: main, code: "MAIN", name: "Main", isArchived: true }), "location_has_stock");
    await reconciled(t);
  });

  it("lets only one of two concurrent issues take the last units", async () => {
    const t = await setupOrg();
    const item = await stockItem(t.ctx, "Last One");
    const main = await withTransaction((tx) => defaultLocationId(tx, t.ctx));
    await withTransaction((tx) => receiveStock(tx, t.ctx, { itemId: item.id, locationId: main, date: "2026-04-01", quantity: "5", value: "50", kind: "opening" }));
    const take = () => withTransaction((tx) => issueStock(tx, t.ctx, { itemId: item.id, locationId: main, date: "2026-04-02", quantity: "5", kind: "adjustment" }));
    const results = await Promise.allSettled([take(), take()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await cost(t.orgId, item.id)).toEqual({ qty: "0", value: "0.00" });
  });

  it("voids a bill's receipt back out, and a sale's issue back in at its cost", async () => {
    const t = await setupOrg();
    const item = await stockItem(t.ctx, "Spring");
    const v = await vendor(t.ctx);
    const c = await customer(t.ctx);
    const b = await issueDocument(t.ctx, (await saveDraft(t.ctx, { kind: "bill", contactId: v.id, issueDate: "2026-05-01", lines: [{ itemId: item.id, quantity: "10", unitPrice: "2" }] })).id);
    const inv = await issueDocument(t.ctx, (await saveDraft(t.ctx, { kind: "invoice", contactId: c.id, issueDate: "2026-05-02", lines: [{ itemId: item.id, quantity: "3", unitPrice: "9" }] })).id);
    await voidDocument(t.ctx, inv.id, { date: "2026-05-03", reason: "Order cancelled" });
    expect(await cost(t.orgId, item.id)).toEqual({ qty: "10", value: "20.00" });
    expect(await balance(t.orgId, await t.acct("cost_of_goods_sold"))).toBe("0.00");
    await voidDocument(t.ctx, b.id, { date: "2026-05-04", reason: "Wrong vendor" });
    expect(await cost(t.orgId, item.id)).toEqual({ qty: "0", value: "0.00" });
    const moves = await getDb().select().from(stockMoves).where(eq(stockMoves.itemId, item.id));
    expect(moves).toHaveLength(4);
    await reconciled(t);
  });

  it("returns stock to the vendor at the credited value and from customers at original cost", async () => {
    const t = await setupOrg();
    const item = await stockItem(t.ctx, "Hinge");
    const v = await vendor(t.ctx);
    const c = await customer(t.ctx);
    await issueDocument(t.ctx, (await saveDraft(t.ctx, { kind: "bill", contactId: v.id, issueDate: "2026-06-01", lines: [{ itemId: item.id, quantity: "10", unitPrice: "3" }] })).id);
    const vc = await saveDraft(t.ctx, { kind: "vendor_credit", contactId: v.id, issueDate: "2026-06-02", lines: [{ itemId: item.id, quantity: "2", unitPrice: "3" }] });
    await issueDocument(t.ctx, vc.id);
    expect(await cost(t.orgId, item.id)).toEqual({ qty: "8", value: "24.00" });
    const inv = await issueDocument(t.ctx, (await saveDraft(t.ctx, { kind: "invoice", contactId: c.id, issueDate: "2026-06-03", lines: [{ itemId: item.id, quantity: "4", unitPrice: "8" }] })).id);
    const { getDocument } = await import("@/lib/commerce/documents");
    const { lines } = await getDocument(getDb(), t.orgId, inv.id);
    const cn = await saveDraft(t.ctx, { kind: "credit_note", contactId: c.id, issueDate: "2026-06-04", lines: [{ itemId: item.id, quantity: "1", unitPrice: "8", returnOfLineId: lines[0]!.id }] });
    await issueDocument(t.ctx, cn.id);
    expect(await cost(t.orgId, item.id)).toEqual({ qty: "5", value: "15.00" });
    await reconciled(t);
  });
});
