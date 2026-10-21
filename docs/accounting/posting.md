# The ledger and the posting engine

Every financial record in Gideon Books — a manual journal entry, an invoice,
a bill, a payment, a settlement, a bank categorization, a stock movement's
cost, depreciation, a payroll run, a revaluation — reaches the ledger through
one function, `postEntry` (`lib/ledger/posting.ts`). There is no second path.

## What a posting is

A **journal entry** has a posting date (the date it affects balances, and so
the fiscal period it belongs to), an optional document date, a kind and a
source (the record that produced it), a description, and two or more
**lines**. Each line has an account, a signed amount in its currency (debit
positive, credit negative), the exchange rate and the resulting signed
**base amount** in the organization's currency, and optionally a contact,
dimensions (project, class, department, location, fund, trust component,
beneficiary), an item and quantity, and an **open item** (the document or
payment a receivable/payable line belongs to).

## What the engine guarantees

| Rule | Enforced by |
|---|---|
| Lines balance in base currency, exactly | engine; database trigger on posting |
| Same-currency entries also balance in that currency | engine |
| Amounts have no more places than their currency's minor units | engine (refuses, never rounds) |
| Foreign amounts convert at a stated rate, half-up per line; a conversion difference of at most half a minor unit per converted line goes to the rounding account, anything more is refused | engine |
| The posting date is in an open period and after the lock date | engine; trigger |
| Accounts, contacts, dimensions and projects belong to the organization | engine; composite foreign keys |
| Archived accounts and dimensions take no new postings | engine; trigger (accounts) |
| Control accounts (receivables, payables, inventory, fixed assets, deposits, prepayments) only take postings from their subledger, tagged with the open item | engine |
| Entry numbers are gapless and unique per organization | row-locked sequence; unique index |
| An entry with an idempotency key posts once; a retry gets the same entry, a different request with the key is refused | unique index + savepoint |
| Posted entries and their lines never change or disappear | triggers |
| Corrections are linked reversals; an entry is reversed at most once | unique index |

## Drafts, posting, reversal

Manual journal entries can be saved as drafts (editable, deletable, not in
any balance) and posted later. Posting assigns the number and the period and
makes the entry permanent. A posted manual or opening-balance entry is
corrected by **reversing** it — a new entry with every line negated, dated on
or after the original, carrying the reason — and posting the right one.
Entries that belong to a document, payment, stock movement, asset or payroll
run are corrected through that record (void, credit note, return, disposal),
so its subledger stays in step; the engine refuses to reverse them directly.

## Periods and the lock date

Fiscal years (twelve monthly periods from the organization's fiscal-year
start month) are created as postings need them. Closing a period runs the
close checklist (`lib/ledger/close-checks.ts`): blockers stop the close,
warnings need an acknowledgement, and the checklist as it stood is saved
with the close. Periods close in order and reopen latest-first; reopening
needs the `periods.reopen` permission and a reason. The **lock date** blocks
every posting on or before it, whatever the period status — set it after a
return is filed or statements are delivered. Every close, reopen and lock
date change is in the audit log and the period history.

## Audit

Every change writes an audit event in the same transaction: organization,
actor (person, API token, job or webhook), timestamp, action, source (UI,
API, job, import, webhook), reason where one was required, and before/after
values with anything secret-looking redacted. The audit table is append-only.
