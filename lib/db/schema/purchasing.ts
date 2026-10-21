/**
 * Purchasing and inventory movement records: purchase-order receipts (goods
 * received ahead of the bill, carried in Goods Received Not Invoiced), the
 * matching of bill lines to received purchase-order lines, the receipt inbox,
 * and the headers of stock adjustments, transfers, opening stock and
 * revaluations.
 */
import { sql } from "drizzle-orm";
import { check, foreignKey, index, pgTable, text, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, day, id, money, orgId, quantity, ts } from "./_columns";
import { organizations, attachments } from "./core";
import { accounts, inventoryLocations, items, journalEntries } from "./ledger";
import { documentLines, documents } from "./commerce";
import { stockMoves } from "./inventory";

/** Goods received against a purchase order. */
export const purchaseReceipts = pgTable(
  "purchase_receipts",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id),
    number: text("number").notNull(),
    purchaseOrderId: uuid("purchase_order_id").notNull(),
    receiptDate: day("receipt_date").notNull(),
    locationId: uuid("location_id").notNull(),
    /** Dr Inventory / Cr Goods Received Not Invoiced for the stock lines (null if none were stock). */
    journalEntryId: uuid("journal_entry_id"),
    status: text("status", { enum: ["posted", "reversed"] }).notNull().default("posted"),
    reversedAt: ts("reversed_at"),
    reversalEntryId: uuid("reversal_entry_id"),
    reversalReason: text("reversal_reason"),
    memo: text("memo"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("purchase_receipts_org_id_uq").on(t.orgId, t.id),
    unique("purchase_receipts_org_number_uq").on(t.orgId, t.number),
    index("purchase_receipts_po_idx").on(t.orgId, t.purchaseOrderId),
    foreignKey({ columns: [t.orgId, t.purchaseOrderId], foreignColumns: [documents.orgId, documents.id] }),
    foreignKey({ columns: [t.orgId, t.locationId], foreignColumns: [inventoryLocations.orgId, inventoryLocations.id] }),
    foreignKey({ columns: [t.orgId, t.journalEntryId], foreignColumns: [journalEntries.orgId, journalEntries.id] }),
    foreignKey({ columns: [t.orgId, t.reversalEntryId], foreignColumns: [journalEntries.orgId, journalEntries.id] }),
  ],
);

export const purchaseReceiptLines = pgTable(
  "purchase_receipt_lines",
  {
    id: id(),
    orgId: orgId(),
    receiptId: uuid("receipt_id").notNull(),
    poLineId: uuid("po_line_id").notNull(),
    itemId: uuid("item_id"),
    quantity: quantity("quantity").notNull(),
    /** Base-currency value carried in Goods Received Not Invoiced (zero for non-stock lines). */
    value: money("value").notNull().default("0"),
    stockMoveId: uuid("stock_move_id"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("purchase_receipt_lines_org_id_uq").on(t.orgId, t.id),
    index("purchase_receipt_lines_po_line_idx").on(t.orgId, t.poLineId),
    foreignKey({ columns: [t.orgId, t.receiptId], foreignColumns: [purchaseReceipts.orgId, purchaseReceipts.id] }).onDelete("cascade"),
    foreignKey({ columns: [t.orgId, t.poLineId], foreignColumns: [documentLines.orgId, documentLines.id] }),
    foreignKey({ columns: [t.orgId, t.itemId], foreignColumns: [items.orgId, items.id] }),
    foreignKey({ columns: [t.orgId, t.stockMoveId], foreignColumns: [stockMoves.orgId, stockMoves.id] }),
    check("purchase_receipt_lines_qty_positive", sql`${t.quantity} > 0`),
  ],
);

/**
 * How a bill line drew on a purchase-order line: the quantity matched to
 * goods already received (relieving Goods Received Not Invoiced at their
 * received value, with any price difference to purchase price variance), and
 * any quantity received with the bill itself.
 */
export const poBillMatches = pgTable(
  "po_bill_matches",
  {
    id: id(),
    orgId: orgId(),
    billId: uuid("bill_id").notNull(),
    billLineId: uuid("bill_line_id").notNull(),
    poLineId: uuid("po_line_id").notNull(),
    /** Billed quantity (all of it counts against the ordered quantity). */
    billedQuantity: quantity("billed_quantity").notNull(),
    /** Of which matched to earlier receipts. */
    matchedQuantity: quantity("matched_quantity").notNull(),
    /** Of which received with the bill. */
    receivedWithBill: quantity("received_with_bill").notNull().default("0"),
    grniValue: money("grni_value").notNull().default("0"),
    varianceValue: money("variance_value").notNull().default("0"),
    status: text("status", { enum: ["active", "reversed"] }).notNull().default("active"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("po_bill_matches_org_id_uq").on(t.orgId, t.id),
    index("po_bill_matches_po_line_idx").on(t.orgId, t.poLineId),
    index("po_bill_matches_bill_idx").on(t.orgId, t.billId),
    foreignKey({ columns: [t.orgId, t.billId], foreignColumns: [documents.orgId, documents.id] }),
    foreignKey({ columns: [t.orgId, t.billLineId], foreignColumns: [documentLines.orgId, documentLines.id] }),
    foreignKey({ columns: [t.orgId, t.poLineId], foreignColumns: [documentLines.orgId, documentLines.id] }),
  ],
);

/** A receipt from the inbox matched to the bill or expense it supports. */
export const receiptMatches = pgTable(
  "receipt_matches",
  {
    id: id(),
    orgId: orgId(),
    /** The inbox attachment. */
    attachmentId: uuid("attachment_id").notNull(),
    documentId: uuid("document_id").notNull(),
    /** The attachment row created on the document for the same file. */
    linkedAttachmentId: uuid("linked_attachment_id"),
    matchedBy: uuid("matched_by"),
    matchedAt: ts("matched_at").notNull().defaultNow(),
    unmatchedAt: ts("unmatched_at"),
    unmatchedBy: uuid("unmatched_by"),
  },
  (t) => [
    unique("receipt_matches_org_id_uq").on(t.orgId, t.id),
    uniqueIndex("receipt_matches_active_uq").on(t.orgId, t.attachmentId).where(sql`${t.unmatchedAt} is null`),
    foreignKey({ columns: [t.orgId, t.attachmentId], foreignColumns: [attachments.orgId, attachments.id] }),
    foreignKey({ columns: [t.orgId, t.documentId], foreignColumns: [documents.orgId, documents.id] }),
  ],
);

/** The header of a stock adjustment, transfer, opening-stock entry or revaluation; its moves carry its id as source. */
export const inventoryMovements = pgTable(
  "inventory_movements",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id),
    number: text("number").notNull(),
    kind: text("kind", { enum: ["opening", "adjustment", "transfer", "revaluation"] }).notNull(),
    movementDate: day("movement_date").notNull(),
    reason: text("reason").notNull(),
    fromLocationId: uuid("from_location_id"),
    toLocationId: uuid("to_location_id"),
    /** The account the value change is booked against (adjustments, revaluations, opening stock). */
    offsetAccountId: uuid("offset_account_id"),
    journalEntryId: uuid("journal_entry_id"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("inventory_movements_org_id_uq").on(t.orgId, t.id),
    unique("inventory_movements_org_number_uq").on(t.orgId, t.number),
    index("inventory_movements_date_idx").on(t.orgId, t.movementDate),
    foreignKey({ columns: [t.orgId, t.fromLocationId], foreignColumns: [inventoryLocations.orgId, inventoryLocations.id] }),
    foreignKey({ columns: [t.orgId, t.toLocationId], foreignColumns: [inventoryLocations.orgId, inventoryLocations.id] }),
    foreignKey({ columns: [t.orgId, t.offsetAccountId], foreignColumns: [accounts.orgId, accounts.id] }),
    foreignKey({ columns: [t.orgId, t.journalEntryId], foreignColumns: [journalEntries.orgId, journalEntries.id] }),
  ],
);

/** A purchase order closed by hand before it was fully received and billed. */
export const poClosures = pgTable(
  "po_closures",
  {
    id: id(),
    orgId: orgId(),
    purchaseOrderId: uuid("purchase_order_id").notNull(),
    reason: text("reason").notNull(),
    closedBy: uuid("closed_by"),
    closedAt: ts("closed_at").notNull().defaultNow(),
    reopenedAt: ts("reopened_at"),
  },
  (t) => [
    uniqueIndex("po_closures_open_uq").on(t.orgId, t.purchaseOrderId).where(sql`${t.reopenedAt} is null`),
    foreignKey({ columns: [t.orgId, t.purchaseOrderId], foreignColumns: [documents.orgId, documents.id] }),
  ],
);
