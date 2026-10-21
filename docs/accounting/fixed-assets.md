# Fixed assets

Code: `lib/assets/` (register `assets.ts`, schedules `schedule.ts`, runs `depreciation.ts`, tax book `tax-book.ts`, rollforward `reports.ts`). Pages under `/o/<org>/assets`.

## The register

Each asset has a number (`FA-0001`), a cost, a residual value, a useful life in months, a method, the three accounts it posts to (asset, accumulated depreciation, depreciation expense) and optional class, department, location and project. Statuses: **draft** (not on the books), **active**, **fully depreciated**, **disposed**.

## Getting the cost onto the books (capitalization)

| how | entry | rule |
|---|---|---|
| From a bill or expense line | none — the bill already debited the fixed-asset account | the asset is linked to that document line; its cost must equal what the line put on the books (base currency, including non-recoverable tax); one asset per line |
| Bought directly | Dr asset, Cr the account that paid (bank, card, loan) on the acquisition date | the funding account may not be a subledger (control) account |
| Opening balance | Dr asset (cost), Cr accumulated depreciation (taken before these books), Cr opening balance equity (the net), dated the month-end the prior depreciation runs through | the prior depreciation may not exceed cost less residual |

A draft can be edited freely. Once capitalized, the cost, accounts, acquisition and in-service date are fixed (the books carry them); the **estimates** — useful life, residual value, method — may change and apply prospectively.

## Depreciation schedules

Monthly, exact decimal arithmetic, rounded half-up to the currency's minor units.

- **Convention:** a full month in the month placed in service; none in the month of disposal.
- **Base:** cost − residual value. Accumulated depreciation never exceeds it; the last month of the life takes exactly what remains, so the schedule always totals cost − residual.
- **Straight line:** each month = (base − accumulated) ÷ months remaining. Computing from what remains makes a change of estimate prospective.
- **Declining balance** (factor *f*, 2 = double declining): each month = (cost − accumulated) × *f* ÷ life in months, switching to the straight-line amount on what remains when that is larger; never below the residual value.
- **None:** land and other non-depreciating assets.
- An opening asset continues from its prior accumulated depreciation over its remaining life (months used = months from in-service through the opening date).

## Depreciation runs

1. **Prepare** a run through a month-end: it lists every asset-month due through that date that is not already in a run, including months an asset missed (catch-up months keep their own month but post in the run's entry).
2. **Review**, then **approve and post**: one entry dated the run's month-end (kind `depreciation`, marked adjusting): Dr each asset's depreciation expense (with its dimensions), Cr its accumulated depreciation.
3. **Reverse** a posted run (with a reason): its entry is reversed and its months are free again. Runs reverse latest first — refused while any of its assets has depreciation posted for a later month.

**Idempotency:** each asset-month is held by at most one draft or posted run line (a unique index on `(org, asset, month)` for lines that are not reversed). Preparing again finds nothing due; posting a posted run returns it unchanged; two people preparing or posting at once produce one run and one entry (row locks and an advisory lock per organization).

The background job `assets.depreciate` (`runMonthlyDepreciation(orgId, periodEnd?)`) prepares the run for the month just ended. It stays a draft for review unless the organization turns on **automatic posting** (off by default; never posts into a closed period).

## Disposal

Dispose (sell, scrap, write off) on a date: refused until depreciation is posted through the month before the disposal month (the message names the months). The entry removes the cost (Cr asset) and the accumulated depreciation (Dr accumulated depreciation), records any proceeds (Dr a bank, cash or other non-subledger asset account), and books proceeds − net book value to **Gain/Loss on Disposal of Assets** (gain is a credit, loss a debit). Draft run lines for the asset are dropped. A disposal can be undone (its entry is reversed, with a reason).

## The tax book

Kept apart from the books; **never posts to the ledger**. Per asset: a method (straight line, declining balance, or amounts entered per tax year), a free-text **method label** (e.g. "MACRS 5-year, half-year" — your record only), the tax basis, tax life and placed-in-service date. Gideon Books does **not** implement MACRS tables, conventions or bonus depreciation, and does not claim tax compliance; enter your preparer's figures by year when they differ from a simple method.

`taxDepreciationDifferences(db, orgId, taxYearStart, taxYearEnd)` returns, for each asset with a tax book, the book depreciation recognized in the window (posted runs by entry date, net of reversals), the tax depreciation, and the difference (tax − book). The Gideon Tax export uses it as a book-to-tax adjustment.

## Rollforward and reconciliation

`/assets/rollforward` (and its CSV export): for a period, per asset — opening cost, additions, disposals, closing cost; opening accumulated depreciation, depreciation, disposals, closing; net book value. Every movement is dated by its ledger entry (capitalization date, run entry date, disposal date, reversal dates), so it uses the same date boundaries as the ledger. It then compares the register's closing cost and accumulated depreciation with the ledger balances of every fixed-asset and accumulated-depreciation account at the period end and shows any difference (for example a bill to an asset account that was never capitalized, or a voided bill whose asset is still in the register).

The period-close checklist warns when active assets have depreciation due through the period end that is not posted.
