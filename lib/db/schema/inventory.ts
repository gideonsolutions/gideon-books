/**
 * The stock ledger. Costing is moving weighted average per item across all
 * locations (docs/accounting/inventory.md). Every movement is a row in
 * stock_moves with its quantity and its value in base currency; item_costs
 * and item_stock hold the running totals, updated under a row lock with the
 * move, so the stock ledger, its totals and the ledger's inventory account
 * always move together.
 */
import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, pgTable, primaryKey, text, unique, uuid, bigserial } from "drizzle-orm/pg-core";
import { createdAt, day, id, money, orgId, quantity, ts, unitAmount } from "./_columns";
import { organizations } from "./core";
import { inventoryLocations, items, journalEntries } from "./ledger";

export const STOCK_MOVE_KINDS = [
  "opening",
  "receipt",
  "sale",
  "sale_return",
  "purchase_return",
  "transfer_out",
  "transfer_in",
  "adjustment",
  "revaluation",
] as const;
export type StockMoveKind = (typeof STOCK_MOVE_KINDS)[number];

export const stockMoves = pgTable(
  "stock_moves",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id),
    /** Global order of moves; within an item, moves are in date then sequence order. */
    seq: bigserial("seq", { mode: "number" }).notNull(),
    itemId: uuid("item_id").notNull(),
    locationId: uuid("location_id").notNull(),
    moveDate: day("move_date").notNull(),
    kind: text("kind", { enum: STOCK_MOVE_KINDS }).notNull(),
    /** Signed: positive into stock, negative out. Zero for a revaluation. */
    quantity: quantity("quantity").notNull(),
    /** Signed value in base currency moved with the quantity. */
    value: money("value").notNull(),
    /** Average unit cost after this move (informational). */
    unitCostAfter: unitAmount("unit_cost_after"),
    qtyOnHandAfter: quantity("qty_on_hand_after").notNull(),
    valueAfter: money("value_after").notNull(),
    sourceType: text("source_type"),
    sourceId: uuid("source_id"),
    sourceLineId: uuid("source_line_id"),
    journalEntryId: uuid("journal_entry_id"),
    /** A move that undoes another (void, return at original cost). */
    reversesMoveId: uuid("reverses_move_id"),
    /** Pairs a transfer_out with its transfer_in. */
    transferGroupId: uuid("transfer_group_id"),
    reason: text("reason"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("stock_moves_org_id_uq").on(t.orgId, t.id),
    index("stock_moves_item_idx").on(t.orgId, t.itemId, t.moveDate, t.seq),
    index("stock_moves_source_idx").on(t.orgId, t.sourceType, t.sourceId),
    foreignKey({ columns: [t.orgId, t.itemId], foreignColumns: [items.orgId, items.id] }),
    foreignKey({ columns: [t.orgId, t.locationId], foreignColumns: [inventoryLocations.orgId, inventoryLocations.id] }),
    foreignKey({ columns: [t.orgId, t.journalEntryId], foreignColumns: [journalEntries.orgId, journalEntries.id] }),
    foreignKey({ columns: [t.orgId, t.reversesMoveId], foreignColumns: [t.orgId, t.id] }),
    check("stock_moves_on_hand_nonnegative", sql`${t.qtyOnHandAfter} >= 0`),
  ],
);

/** Running totals per item (all locations): the average cost is value ÷ quantity. */
export const itemCosts = pgTable(
  "item_costs",
  {
    orgId: orgId(),
    itemId: uuid("item_id").notNull(),
    qtyOnHand: quantity("qty_on_hand").notNull().default("0"),
    totalValue: money("total_value").notNull().default("0"),
    lastMoveDate: day("last_move_date"),
    moveCount: integer("move_count").notNull().default(0),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.itemId] }),
    foreignKey({ columns: [t.orgId, t.itemId], foreignColumns: [items.orgId, items.id] }),
    check("item_costs_nonnegative", sql`${t.qtyOnHand} >= 0`),
    check("item_costs_zero_value_at_zero_qty", sql`${t.qtyOnHand} > 0 or ${t.totalValue} = 0`),
  ],
);

/** Quantity on hand per item per location. */
export const itemStock = pgTable(
  "item_stock",
  {
    orgId: orgId(),
    itemId: uuid("item_id").notNull(),
    locationId: uuid("location_id").notNull(),
    qtyOnHand: quantity("qty_on_hand").notNull().default("0"),
    reorderLevel: quantity("reorder_level"),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.itemId, t.locationId] }),
    foreignKey({ columns: [t.orgId, t.itemId], foreignColumns: [items.orgId, items.id] }),
    foreignKey({ columns: [t.orgId, t.locationId], foreignColumns: [inventoryLocations.orgId, inventoryLocations.id] }),
    check("item_stock_nonnegative", sql`${t.qtyOnHand} >= 0`),
  ],
);
