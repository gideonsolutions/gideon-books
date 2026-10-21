# Financial reports

All reports live in `lib/reports` and are built from one query layer
(`ledgerRows` in `lib/reports/ledger.ts`) over the **posted** ledger. Drafts
never appear. Every amount is in the organization's base currency at the rate
stored on each posting (historical rates never change); the general ledger
also shows each line's original currency and amount.

## Common rules

- **Dates.** Reports select by posting date (`entry_date`). A range report
  covers `from` to `to` inclusive; an as-of report covers everything up to and
  including its date. Fiscal years follow the organization's fiscal-year start
  month.
- **Basis.** Accrual or cash, per `docs/accounting/cash-basis.md`.
- **Filters.** Account(s), contact, project, class, department, location,
  fund, trust component and beneficiary filter ledger lines. A dimension
  filter of `none` selects lines without that dimension. Filtered balance
  sheets and trial balances need not balance, and say so.
- **Drill-down.** Every account figure links to the general ledger with the
  same dates, basis and filters (`/reports/general-ledger?account=…`); the
  general-ledger lines behind a link sum to the figure
  (`tests/reports/statements.test.ts` checks every link on the trial balance,
  balance sheet and profit and loss). Computed lines (retained earnings,
  current-year earnings, net income) link to the profit and loss for their
  period.
- **Exports.** Each report produces one `ReportTable`
  (`lib/reports/table.ts`); the page, the CSV and the PDF are rendered from it
  (`lib/reports/export.ts`), so they cannot disagree
  (`tests/reports/registry.test.ts` builds every report on both bases and
  compares every CSV cell with the table). CSV amounts are plain decimal
  strings; text cells a spreadsheet would treat as a formula are prefixed with
  an apostrophe. Exports are audited (`report.exported`).

## The reports

| report | what it shows | checks |
|---|---|---|
| Profit and loss | income, cost of goods sold, gross profit, expenses, net operating income, other income and expenses, net income; compared with the previous period, the previous year, month by month or quarter by quarter; or one column per project, class, department, location or fund | net income equals current-year earnings on the balance sheet |
| Balance sheet | assets, liabilities and equity by type with subaccounts; retained earnings = net income of all earlier fiscal years plus retained-earnings accounts; current-year earnings = net income since the fiscal year began; comparisons by date | assets = liabilities + equity; any difference is shown as a warning |
| Statement of cash flows | indirect method: net income, depreciation add-back (accumulated depreciation), changes in working capital (operating), investing, financing, and opening-balance / retained-earnings adjustments, by each account's cash-flow section | the net change equals the change in cash accounts (bank, cash, clearing); a difference is shown as a warning |
| Trial balance | each account's debit or credit balance on a date: balance-sheet accounts cumulative, income and expense for the fiscal year to date, earlier years' net income as one retained-earnings line | debits = credits |
| General ledger | per account: balance brought forward, each line with date, entry number, source, contact, description, debit, credit, running balance, original currency; balance carried forward | lines sum to the closing balance |
| Journal | entries in a range with their lines | debits = credits |
| Account activity | opening, debits, credits, closing per account | |
| AR / AP aging | open items as of a date by days past due (current, 1–30, 31–60, 61–90, over 90), per customer or vendor, optionally per document | total = the receivable / payable control account on that date |
| Customer / vendor balances | balance per contact, and deposits or prepayments held | |
| Sales tax liability | per jurisdiction: taxable and exempt sales and tax charged (from the tax kept on each issued document, by document date, converted at the document's rate, credit notes negative); from the ledger, owed at start, collected, remitted, adjusted, owed at end; recoverable purchase tax | Gideon Books does not file returns |
| Project profitability | income, costs, profit, margin per project, with the project's cost budget | |
| Inventory valuation | quantity, average cost and value per stock item from the stock ledger, and the inventory accounts' balances | stock ledger = ledger |
| Budget vs actual | budget, actual, variance and variance % per account (and dimension) for a range of months | |

Reports kept by other modules are linked from the reports page: the fixed
asset rollforward (`/assets/rollforward`), the Gideon Tax book-to-tax
reconciliation (`/tax`), and entity groups (`/consolidation`).

## Budgets

`lib/budgets`: a budget covers the twelve months of a fiscal year for income
and expense accounts, optionally per project, class, department, location or
fund. It can start from last year's actual results adjusted by a percentage,
from another budget, or empty. Amounts are entered as positive numbers for
both income and expenses; variance is actual minus budget.
