/** Read models for the inventory pages: stock on hand, item stock and value, reorder. */
import { and, asc, eq, sql } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import { inventoryLocations, items } from "@/lib/db/schema/ledger";
import { itemCosts, itemStock } from "@/lib/db/schema/inventory";
import { Decimal } from "@/lib/money/decimal";

export interface StockRow {
  itemId: string;
  name: string;
  sku: string | null;
  unit: string;
  qtyOnHand: string;
  totalValue: string;
  avgCost: string | null;
  reorderLevel: string | null;
  reorderQuantity: string | null;
  belowReorder: boolean;
  isArchived: boolean;
  byLocation: { locationId: string; locationName: string; qty: string; reorderLevel: string | null }[];
}

/** Every stock item with its quantity, value and average cost, and quantity per location. */
export async function stockOnHand(db: DbOrTx, orgId: string, opts: { q?: string; locationId?: string; belowReorderOnly?: boolean; includeArchived?: boolean } = {}): Promise<StockRow[]> {
  const rows = await db
    .select({ item: items, cost: itemCosts })
    .from(items)
    .leftJoin(itemCosts, and(eq(itemCosts.orgId, items.orgId), eq(itemCosts.itemId, items.id)))
    .where(and(eq(items.orgId, orgId), eq(items.kind, "stock"), opts.includeArchived ? sql`true` : eq(items.isArchived, false)))
    .orderBy(asc(items.name));
  const locs = await db
    .select({ s: itemStock, name: inventoryLocations.name })
    .from(itemStock)
    .innerJoin(inventoryLocations, and(eq(inventoryLocations.orgId, itemStock.orgId), eq(inventoryLocations.id, itemStock.locationId)))
    .where(eq(itemStock.orgId, orgId));
  const q = opts.q?.toLowerCase();
  const out: StockRow[] = [];
  for (const { item, cost } of rows) {
    if (q && !item.name.toLowerCase().includes(q) && !(item.sku ?? "").toLowerCase().includes(q)) continue;
    const qty = Decimal.from(cost?.qtyOnHand ?? "0");
    const value = Decimal.from(cost?.totalValue ?? "0");
    const byLocation = locs
      .filter((l) => l.s.itemId === item.id && (!Decimal.from(l.s.qtyOnHand).isZero() || l.s.reorderLevel))
      .map((l) => ({ locationId: l.s.locationId, locationName: l.name, qty: l.s.qtyOnHand, reorderLevel: l.s.reorderLevel }));
    const scopeQty = opts.locationId ? Decimal.from(byLocation.find((b) => b.locationId === opts.locationId)?.qty ?? "0") : qty;
    const below = !!item.reorderLevel && scopeQty.lte(item.reorderLevel);
    if (opts.belowReorderOnly && !below) continue;
    if (opts.locationId && scopeQty.isZero() && !opts.belowReorderOnly) continue;
    out.push({
      itemId: item.id,
      name: item.name,
      sku: item.sku,
      unit: item.unit,
      qtyOnHand: (opts.locationId ? scopeQty : qty).toString(),
      totalValue: value.toString(),
      avgCost: qty.isZero() ? null : value.div(qty, 4, "half_up").toString(),
      reorderLevel: item.reorderLevel,
      reorderQuantity: item.reorderQuantity,
      belowReorder: below,
      isArchived: item.isArchived,
      byLocation,
    });
  }
  return out;
}

/** Quantity on hand, value and average cost of one item, by location. */
export async function itemStockDetail(db: DbOrTx, orgId: string, itemId: string) {
  const [cost] = await db.select().from(itemCosts).where(and(eq(itemCosts.orgId, orgId), eq(itemCosts.itemId, itemId)));
  const locs = await db
    .select({ s: itemStock, name: inventoryLocations.name, code: inventoryLocations.code })
    .from(itemStock)
    .innerJoin(inventoryLocations, and(eq(inventoryLocations.orgId, itemStock.orgId), eq(inventoryLocations.id, itemStock.locationId)))
    .where(and(eq(itemStock.orgId, orgId), eq(itemStock.itemId, itemId)))
    .orderBy(asc(inventoryLocations.name));
  const qty = Decimal.from(cost?.qtyOnHand ?? "0");
  const value = Decimal.from(cost?.totalValue ?? "0");
  return {
    qtyOnHand: qty.toString(),
    totalValue: value.toString(),
    avgCost: qty.isZero() ? null : value.div(qty, 4, "half_up").toString(),
    lastMoveDate: cost?.lastMoveDate ?? null,
    byLocation: locs.map((l) => ({ locationId: l.s.locationId, name: l.name, code: l.code, qty: l.s.qtyOnHand })),
  };
}

/** Stock value per item as of a date, from the stock ledger (for the valuation report). */
export async function valuationAsOf(db: DbOrTx, orgId: string, asOf: string) {
  const res = await db.execute<{ item_id: string; name: string; sku: string | null; unit: string; account_id: string | null; qty: string; value: string }>(sql`
    select i.id as item_id, i.name, i.sku, i.unit, i.inventory_account_id as account_id,
           coalesce(sum(m.quantity), 0)::text as qty, coalesce(sum(m.value), 0)::text as value
    from items i
    left join stock_moves m on m.org_id = i.org_id and m.item_id = i.id and m.move_date <= ${asOf}
    where i.org_id = ${orgId} and i.kind = 'stock'
    group by i.id, i.name, i.sku, i.unit, i.inventory_account_id
    order by i.name
  `);
  return res.rows.map((r) => {
    const q = Decimal.from(r.qty);
    return { ...r, avgCost: q.isZero() ? null : Decimal.from(r.value).div(q, 4, "half_up").toString() };
  });
}
