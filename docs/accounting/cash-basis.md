# Cash-basis reporting

Gideon Books keeps one set of books, on the accrual basis. Every report can
also be read on the **cash basis**. The cash basis is not produced by
filtering on payment dates: it is a defined transformation of the posted
ledger, implemented in `lib/reports/ledger.ts` (`ledgerRows`) on top of the
cash-basis projection written when documents are settled
(`lib/commerce/settlements.ts`, table `cash_basis_lines`). This page is the
policy, exactly as implemented, and `tests/reports/cash-basis.test.ts` checks
every example below.

## The rule

Every posted journal entry carries a cash-basis treatment, set by whatever
posted it:

| treatment | what posts it | on the cash basis |
|---|---|---|
| `as_is` | manual journals, sales receipts, expenses paid at once, payments, deposits, refunds, prepayments, bank categorizations, transfers, inventory movements and cost of goods sold, depreciation, payroll, sales-tax remittances, revaluation of foreign **money accounts** | included unchanged, on its date |
| `deferred` | invoices, credit notes, write-offs, bills, vendor credits (anything that creates a receivable or payable); revaluation of foreign **receivables and payables** | left out entirely |
| `settlement` | applying a payment, deposit, credit, refund or write-off to a document | see below |

A **settlement** moves an amount from one open item to another. On the cash
basis:

1. Its lines that relieve a **document** (an invoice, credit note, write-off,
   bill or vendor credit) are left out, and replaced by the **recognition** of
   that document: each of the document's own lines (income, expense, tax,
   inventory…) in proportion to the amount settled, dated the settlement date.
   The settlement that clears a document recognizes exactly what is left, so a
   fully settled document is recognized in full, to the cent.
2. Its lines that relieve a **payment** (a customer payment, deposit, refund,
   vendor payment, prepayment) stay. A payment's own entry is `as_is`, so
   unapplied money stays on the balance sheet — as a credit on the customer's
   receivable, as customer deposits, or as vendor prepayments — until it is
   applied.
3. A settlement **between two documents** (a credit note, write-off or vendor
   credit applied to an invoice or bill) moves no cash, so it is left out
   entirely, together with the recognition it would carry. Neither the credit
   nor the share of the invoice it settled is ever recognized.
4. Its realized exchange-difference line (if any) stays.

Removing a settlement (unapplying, or voiding a payment) posts a reversal and
negates its recognition on the date of removal.

The result balances entry by entry: every entry's cash-basis lines sum to
zero, so the cash-basis trial balance and balance sheet always balance
(`unbalancedEntries(db, orgId, "cash")` is always empty).

## What it means in practice

Each example is a test in `tests/reports/cash-basis.test.ts`.

**Partial payments and sales tax.** An invoice for 1,000 plus 10% tax (1,100)
paid 440 in January and 660 in February: on the cash basis January shows
income 400 and sales tax payable 40 (440 ÷ 1,100 of each line); February the
remaining 600 and 60. Accrual shows all of it in January, with 660 receivable
at the end of January. Sales tax is recognized with the income it was charged
on.

**Deposits and prepayments.** A 300 deposit received in January stays a
liability (customer deposits) until it is applied; applying it to the February
invoice recognizes the income on the application date, February. The cash
basis therefore never shows income before there is an invoice for it.

**Credit notes and write-offs.** An invoice of 500 reduced by a 100 credit note
and paid 400 shows income 400 on the cash basis — the credit note's returns
account shows nothing, because the credit settled part of the invoice without
cash. An invoice written off shows neither the income nor the bad-debt expense
on the cash basis: there was no cash, so there is no income and no deduction.
(On the accrual basis the income, the returns and the bad debt all appear.)

**Unapplied overpayments.** A payment of 150 against a 100 invoice recognizes
100 of income; the 50 unapplied stays on the balance sheet as a credit on
accounts receivable (owed back to the customer, or to be applied later).

**Foreign currency.** A EUR 1,000 invoice booked at 1.10 (1,100) and paid at
1.05 (1,050 received): the cash basis recognizes the invoice's income at its
own rate, 1,100, and the realized exchange loss of 50, so net income equals
the 1,050 received. Unrealized revaluation of receivables and payables is
left out on the cash basis (they do not exist there); revaluation of foreign
bank balances is kept.

**Inventory bought on credit.** Stock movements and cost of goods sold are
recorded when they happen on both bases. A bill for inventory is recognized
on the cash basis when it is paid. Selling stock from an unpaid bill therefore
shows cost of goods sold and a temporarily negative inventory balance on the
cash-basis balance sheet, which becomes the accrual figure once the bill is
paid. This is the same behavior as the common small-business packages; it
keeps cost of goods sold matched to the sale.

**Everything else** — journal entries, bank categorizations, transfers,
payroll, depreciation, owner contributions and draws, loans, sales receipts and
expenses paid at once — appears on its posting date exactly as on the accrual
basis.

## Where it is used

Every report built on `lib/reports` takes a basis: the profit and loss, the
balance sheet, the trial balance, the cash-flow statement, the general ledger,
the journal, account activity, project profitability, budget versus actual and
the Gideon Tax book-to-tax reconciliation. The aging reports, contact balances,
the sales-tax liability report and inventory valuation are accrual by nature
(they describe what is owed, charged or held) and say so.

The organization's default basis (Settings → Organization) only chooses which
basis a report opens on; both are always available.
