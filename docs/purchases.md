# Purchases and payables

What vendors bill, what was bought outright, what is ordered, and what has
been paid. Code: `lib/commerce` (documents, payments, settlements — shared
with sales), `lib/purchases` (orders, receiving, matching, recurring bills,
receipt inbox), pages under `app/o/[org]/purchases`.

## Documents

| kind | posts | owed afterwards |
|---|---|---|
| **Bill** | Dr expense / asset / inventory (+ recoverable tax), Cr Accounts Payable | yes, until paid, credited or voided |
| **Expense** | Dr expense …, Cr the bank, card or cash account that paid | no |
| **Vendor credit** | the reverse of a bill | it is a credit to apply or have refunded |
| **Purchase order** | nothing | — (see receiving below) |

- The vendor's own invoice number goes in **Reference**; Gideon Books numbers
  each bill too (`BILL-0001`).
- The due date comes from the payment terms (the bill's, else the vendor's)
  unless entered.
- Tax on purchases is part of the line's cost unless the jurisdiction has a
  recoverable-tax account, in which case it is recorded there.
- A posted bill cannot be edited. Void it (with a reason; its entries are
  reversed on the void date), or issue a vendor credit for the difference.
  A bill with payments or credits applied must have them removed first.
- **Expense reimbursements.** An employee's out-of-pocket expense is a bill
  with the employee as the contact and "Employee expense to reimburse"
  ticked. It is owed to the employee until a payment is recorded against it,
  and the bills list can show reimbursements only.
- **What's due** (`/purchases/bills/due`) groups open bills into overdue,
  due in the next seven days and later, with totals per currency.

## Payments

Recording a payment records that money moved — **Gideon Books never sends
money**, and there is no payment initiation anywhere in it.

- **Pay bills**: a payment to a vendor, applied to one or more open bills,
  partially or in full. What is not applied stays as a credit with the vendor
  and can be applied later.
- **Prepayment**: paid before the bill, held in Vendor Prepayments and applied
  when the bill arrives.
- **Refund from a vendor**: money back, applied to their vendor credits,
  prepayments or overpayments.
- Foreign-currency bills are paid in their currency; the difference between
  the rate the bill was recorded at and the payment's rate is a realized
  exchange gain or loss.
- Removing an application or voiding a payment (each with a reason) reopens
  what it settled; history keeps both.

Accounts Payable is kept by its subledger: each line on it is tagged with
the bill, credit or payment it belongs to, so the open items always add up to
the account balance (tests: `tests/purchases/payables.test.ts`).

## Purchase orders

Orders are issued, received (partially or fully, into a stock location),
billed (matched three ways: ordered, received, billed) and closed. Stock
received before the bill sits in Goods Received Not Invoiced; the bill
clears it and books any price difference to Purchase Price Variance. Billing
more than ordered needs a confirmation. Details in
`docs/accounting/inventory.md`. Orders can be downloaded as a PDF to send.

## Recurring bills

A schedule copies a bill (vendor, lines, accounts, tax codes, dimensions)
every week, month, quarter or year from a start date, optionally until an
end date or a number of bills, as drafts or posted automatically. Each
scheduled date produces exactly one bill however often or however
concurrently the `purchases.recurring` job runs: occurrences are produced
under a Postgres advisory lock per schedule, a bill already produced for a
date is found and linked rather than duplicated, and `recurring_runs` is
unique per schedule and date. A failed occurrence is retried on the next run
before any later one. `runDueRecurringBills(today?)` is the scheduler's entry
point.

## Receipt inbox

Upload receipts as they arrive (`/purchases/receipts`), then match each to the
bill or expense it supports, or start a new expense or bill from it. Matching
puts the same file among the document's attachments; unmatching takes it off
and returns the receipt to the inbox. Both are in the audit trail.

Gideon Keep keeps supporting documents for its own accounts, but publishes
no interface for Books to read receipts from; the inbox therefore accepts
uploads only, and nothing here claims a Keep connection.
