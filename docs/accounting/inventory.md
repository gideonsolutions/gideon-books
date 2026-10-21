# Inventory costing and the stock ledger

Gideon Books keeps a perpetual stock ledger (`stock_moves`) next to the
general ledger. Every movement of a stock item — a receipt, a sale, a return,
a count adjustment, a transfer, a revaluation — is a row with a signed
quantity and a signed value in the organization's base currency. Running
totals per item (`item_costs`) and per item and location (`item_stock`) are
updated in the same transaction, under a row lock, as the move and the
ledger entry that goes with it. The code is `lib/inventory/stock.ts`.

## Costing method: moving weighted average, per item, across locations

- An item has one average cost for all its locations: total value ÷ total
  quantity on hand.
- A receipt adds its quantity and its value (what was paid for it, converted
  to base currency at the document's rate) and so moves the average.
- An issue (a sale, a return to the vendor, a loss) takes value
  `total value × issued ÷ on hand`, rounded half-up to the base currency's
  minor units. The average itself is never rounded; only the value moved is.
- **Last-unit rule.** Issuing everything that is on hand takes all the
  remaining value, so an item with no stock has exactly zero value — rounding
  never leaves a few cents stranded in the inventory account.
- A transfer between locations moves quantity only: the value stays with the
  item (one average for all locations), and nothing posts to the ledger.
- A revaluation changes the value without changing the quantity (a
  write-down for damage, a landed-cost addition).

## Rules that prevent wrong costs

1. **No negative stock.** An issue may not take more than is on hand at the
   location, nor more than the item has in total. Record the receipt first.
   (There is no setting to allow it: costing stock you do not have produces a
   cost the books would have to correct later.)
2. **Movements are in date order per item.** A movement dated before the
   item's latest movement is refused. A backdated receipt would change the
   average cost of issues already posted (and their cost-of-goods entries,
   which are immutable). Record it on or after the latest date, or record a
   revaluation to correct the value.
3. **Corrections are new movements.** Stock moves cannot be edited or deleted
   (a database trigger refuses it). Voiding an invoice returns the stock at the
   value it left at; voiding a bill takes the stock back out at the value it
   came in at (refused if it has already been sold — issue a vendor credit
   instead).

## Where each movement posts

| movement | stock | ledger |
|---|---|---|
| Bill or expense line for a stock item | in, at the line's cost (net + tax that is not recoverable) in base | Dr Inventory (on the bill's entry) |
| Invoice or sales receipt line | out, at average cost | separate entry: Dr Cost of goods sold / Cr Inventory |
| Credit note returning a sale | in, at the cost it left at (linked to the original invoice line), else at the current average | Dr Inventory / Cr Cost of goods sold |
| Vendor credit returning a purchase | out, at the credited value | Cr Inventory (on the credit's entry) |
| Purchase-order receipt | in, at the order's net price at the receipt date's rate | Dr Inventory / Cr Goods Received Not Invoiced |
| Opening stock | in, at the cost entered | Dr Inventory / Cr Opening Balance Equity |
| Quantity adjustment (count, damage, found) | out at average cost, or in at the cost entered (or the current average) | Dr/Cr Inventory against Inventory Shrinkage and Adjustments (or a chosen account) |
| Revaluation | value only | Dr/Cr Inventory against the chosen account |
| Transfer | out of one location, into another, same value | none |

Cost-of-goods entries are separate from the invoice's own entry because they
are treated differently on the cash basis: the invoice is recognized as it is
paid, while the stock movement and its cost are recognized when they happen.

## Purchase orders, receipts and three-way matching

- A purchase order posts nothing.
- **Receiving** goods against it (`lib/purchases/receiving.ts`) brings stock
  in at the order's net price per unit, converted at the receipt date's rate,
  and credits **Goods Received Not Invoiced** (GRNI) — a liability for goods
  held but not yet billed. Non-stock lines record the quantity received only.
  Receiving more than was ordered is refused.
- **Billing** (`lib/purchases/matching.ts`): a bill line that comes from an
  order line first matches the quantity already received and not yet billed.
  That part debits GRNI at the value it was received at (pro rata, exact on
  the last unit), and any difference between that value and what the bill
  charges for it — including tax that is not recoverable, and any change in
  exchange rate between receipt and bill — goes to **Purchase Price Variance**.
  Quantity billed beyond what was received is received with the bill (stock in
  at the bill's value, as for a bill without an order).
- Billing more than was ordered is refused unless the person confirms it
  (the "post, billing more than ordered" action).
- The order's status follows its lines: partially received, received, and
  closed once everything is both received and billed. An order can be closed
  by hand (and reopened); an order with nothing received or billed can be
  cancelled.
- A receipt can be reversed while none of it has been billed and the stock is
  still on hand; the order's received quantities fall back.
- Voiding a matched bill undoes its matches: the order lines are open to bill
  again, and GRNI is restored by the reversal of the bill's entry.

## Reconciliation

`/inventory/valuation` (and `inventoryReconciliation` in
`lib/inventory/valuation.ts`) compares, per inventory account and as of any
date, the value in the stock ledger with the balance of the account in the
general ledger. Because every movement and its entry commit together and
inventory accounts are control accounts (manual journal entries are refused),
they agree; the period-close checklist refuses to close a period in which
they do not.
