# Gideon Tax export contract, version 1.0

Gideon Books owns the accounting; Gideon Tax owns tax computation, return
preparation and filing. This file is the hand-off between them: a JSON
package (format `gideon-books.tax-export`, version `1.0`) describing one
organization's books for one tax year, mapped to the lines of one return,
with the book-to-tax adjustments recorded beside the books. The
machine-readable definition is
[`gideon-tax-export.schema.json`](gideon-tax-export.schema.json) (JSON Schema
2020-12).

**There is no live integration.** Gideon Tax does not publish an import API
for business books, so Gideon Books does not pretend to send anything: the
package is generated under **Reports → Gideon Tax export** (`/o/<org>/tax`),
stored as an attachment, and downloaded (JSON, plus a CSV of the same
figures). When Gideon Tax publishes an import contract, an adapter goes in
`lib/taxexport/` and this document records it.

## What Gideon Books does and does not do

- It maps accounts (or an account for one project, class, department, location
  or fund) to return lines, in **versioned** mapping sets.
- It records **book-to-tax adjustments** (permanent or temporary) per tax year.
  They never post to the ledger.
- It produces a **reconciliation**: book amount, adjustments and tax amount per
  category; accounts with a balance but no mapping; and a person's review or
  approval tied to a hash of the data.
- It does **not** compute tax, decide what is deductible, prepare schedules, or
  file anything. "Taxable income before special items" in the package is only
  income less cost of goods sold and deductions as mapped — not taxable income.

## Line catalogs and their source

The categories for each return come from Gideon Tax's own form builders in the
`gideon-tax-backends` repository, read on 2026-10-21. Only the lines a set of
books supplies directly are listed (page-1 income, cost of goods sold and
deductions); computed lines and lines from other schedules are not.

| return type | form | tax year / MeF package | source file | commit |
|---|---|---|---|---|
| `1120` | Form 1120, lines 1a–10, 12–26 | 2026 / 2026v3.0 | `gideon-1120-backend/src/forms/returns/form_1120.rs` | `86107e7` |
| `1120S` | Form 1120-S, lines 1a–5, 7–20 | 2026 / 2026v3.0 | `gideon-1120-backend/src/forms/returns/form_1120s.rs` | `86107e7` |
| `1065` | Form 1065, lines 1a–7, 9–21 | 2026 / 2026v3.0 | `gideon-1065-backend/crates/gideon-1065-forms/src/returns/form_1065.rs` | `fdbd0e7` |
| `schedule_c` | Schedule C (Form 1040), lines 1, 2, 4, 6, 8–27b | 2025 / 2025v5.3 | `gideon-1040-backend/crates/gideon-1040-forms/src/schedules/schedule_c.rs` | `2de688f` |
| `custom` | the organization's own categories only | — | — | — |

Not offered, because no definition was found to take them from: Form 990
(the `gideon-990-backend` exists but its line structure was not read for this
version), Form 1041 and state returns. Organizations can define their own
categories for any return type.

Every return type also has three Gideon Books categories, which are not form
lines: `BK_NONDEDUCTIBLE` (not deductible), `BK_NONTAXABLE` (not taxable income)
and `BK_SEPARATELY_STATED` (an item stated separately on Schedule K, completed
in Gideon Tax). Category codes for form lines are `L` + the line (`L1a`,
`L16b`); custom categories use the organization's code.

## Versioning

A mapping set (one per return type per organization) has numbered versions.
The current version is edited in place until an export uses it; the export
locks it. The next change creates a new version (a copy) — so every package
names exactly the mappings it was built from (`mapping.setVersion`,
`mapping.versionId`), and old packages stay reproducible.

## Determinism and provenance

`provenance.contentHash` is the SHA-256 of the package's canonical JSON (keys
sorted, no whitespace) **without** `provenance.contentHash`,
`provenance.generatedAt` and `provenance.generatedBy`. The same books,
mappings, adjustments and review always give the same hash; generating again
returns the existing package. `provenance.sourceHash` is the hash the review
was taken against: if it matches `review`'s data, the review is `current`.
`provenance.entryCount` and `provenance.lastEntryNumber` identify the posted
entries in the period.

## Amounts and signs

Amounts are decimal strings in the base currency with its minor units
(`"1250.00"`). Income and nontaxable categories are **credit-positive** (income
is positive; a returns-and-allowances account shows a negative amount, which
reduces income). Cost of goods sold, deductions and nondeductible categories
are **debit-positive**. Account `ledgerAmount`s are the raw ledger sums,
debit-positive. An adjustment's `amount` is added to its category's book
amount in the category's own sign (−200 on a deduction category reduces the
deduction by 200). For each category, `taxAmount = bookAmount + adjustments`.

## Package outline

```json
{
  "format": "gideon-books.tax-export",
  "formatVersion": "1.0",
  "organization": { "id": "…", "name": "Harbor & Pine LLC", "legalName": null, "entityType": "c_corporation", "country": "US", "baseCurrency": "USD", "fiscalYearStartMonth": 1 },
  "period": { "start": "2026-01-01", "end": "2026-12-31" },
  "basis": "accrual",
  "returnType": "1120",
  "catalog": { "name": "Form 1120 — …", "taxYear": "2026", "package": "2026v3.0", "source": { "repository": "gideon-tax-backends", "path": "…", "commit": "86107e7", "read": "2026-10-21" } },
  "mapping": { "setVersion": 1, "versionId": "…" },
  "amountsAre": "…",
  "categories": [{ "code": "L26", "line": "26", "description": "Other deductions", "kind": "deduction", "origin": "catalog", "bookAmount": "400.00", "adjustments": "-200.00", "taxAmount": "200.00", "accounts": ["6350 Meals"] }],
  "accounts": [{ "id": "…", "code": "6350", "name": "Meals", "type": "expense", "subtype": "operating_expense", "dimension": null, "ledgerAmount": "400.00", "categoryCode": "L26", "mappingConfirmed": true }],
  "unmapped": [],
  "adjustments": [{ "id": "…", "categoryCode": "L26", "kind": "permanent", "amount": "-200.00", "description": "50% of meals not deductible", "source": "meals_limitation", "sourceRef": null }],
  "taxDepreciation": { "available": true, "assets": [{ "assetId": "…", "assetName": "FA-0001 Van", "bookDepreciation": "6000.00", "taxDepreciation": "12000.00", "difference": "6000.00" }] },
  "totals": { "bookNetIncome": "300.00", "taxableIncomeBeforeSpecialItems": "500.00" },
  "review": { "status": "approved", "by": "owner@example.com", "at": "2027-02-10T15:02:11.000Z", "current": true },
  "provenance": { "application": "Gideon Books", "applicationVersion": "0.1.0", "sourceHash": "…", "contentHash": "…", "entryCount": 412, "lastEntryNumber": 1290, "generatedAt": "2027-02-10T15:05:00.000Z", "generatedBy": "owner@example.com" }
}
```

`taxDepreciation` comes from the fixed-asset register's tax book
(`lib/assets/tax-book.ts`, `taxDepreciationDifferences`); `available: false`
means the register did not provide it. A consumer should refuse a package
whose `unmapped` is not empty unless a person accepts the omission, and should
show `review.current: false` as "changed since review".

## The CSV

The CSV carries the same figures in sections (`category`, `account`,
`adjustment`, `totals`), with the content hash and mapping version on its
second line. It is for people; the JSON is the contract.
