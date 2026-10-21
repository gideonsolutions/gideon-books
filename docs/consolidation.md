# Entity groups and consolidation

An entity group consolidates several organizations kept in Gideon Books. A
group belongs to the person who created it, not to any organization, and
nothing the group does posts to a member's books: mappings, translation,
eliminations and the consolidated statements exist only at group level.

## Access

On every request: a person may **view** a group only while they can read
reports in every member organization, and **manage** it (members, mappings,
rates, eliminations) only while they hold the consolidation permission
(accountant, administrator or owner) in every member. A group without
members is visible to its creator only. Demonstration companies can be
grouped only with demonstration companies.

## Setting up

1. Create the group and choose its reporting currency.
2. Add members (with an ownership percentage, recorded for presentation;
   consolidation is full).
3. Build the group chart. *Use this chart for the group* copies one member's
   chart and maps every member account with the same code and type; map the
   rest by hand. Two accounts the consolidation posts to exist from the start:
   **Retained Earnings (prior periods)** and **Cumulative Translation Adjustment**.
4. Enter translation rates for member currencies (or rely on rates kept in
   the members' books, below).
5. Pair intercompany accounts (a receivable in one member with the payable in
   another; or a management-fee income with the matching expense).

## The consolidated statements (exact method)

For a calendar range `from`–`to`:

1. **Member balances** (accrual basis, posted entries only, member base
   currency): balance-sheet accounts as of `to`; income and expense for the
   range; income and expense before `from` are added to the group's prior-period
   retained earnings.
2. **Mapping** to group accounts. A member account with a non-zero amount and
   no mapping is a **blocker**: it is listed, shown on an "Unmapped" line so
   the statements still foot, and the report is marked incomplete.
3. **Translation** to the reporting currency — the current-rate method,
   simplified:
   - income and expense at the **average rate** for the range (the arithmetic
     mean of the rates dated within it; if there are none, the closing rate,
     with a note);
   - assets, liabilities and equity (including prior-period earnings) at the
     **closing rate** (the latest rate on or before `to`, looked back up to 31
     days; older than 7 days is flagged);
   - each translated amount is rounded half-up to the reporting currency's
     minor units;
   - whatever no longer foots is the member's **cumulative translation
     adjustment** (equity): the difference between average and closing rates
     on the period's income and expense, plus rounding.

   Equity is *not* carried at historical rates; prior periods' translation
   differences are therefore embedded in equity at the closing rate rather
   than accumulated separately. This is a documented simplification of
   ASC 830 / IAS 21, adequate for management reporting; it is not a
   certified statutory consolidation.

   **Rates**, in order of preference: the group's own rates; rates kept by a
   member whose base currency is the reporting currency; the member's own
   rates for the reporting currency, inverted. The report lists the rate,
   its source and its date for every member.
4. **Eliminations** (reporting currency): balance-sheet lines dated on or
   before `to`; income and expense lines dated within the range (earlier ones
   fall into prior-period earnings). Voided eliminations are ignored.

The consolidated trial balance always foots (by construction); the report
says so, and would say loudly if it did not.

## Different fiscal years

Members may keep different fiscal years. Consolidation is always by calendar
date range, the same range for every member; the report lists each member's
fiscal-year start and warns when they differ.

## Intercompany and eliminations

The intercompany report shows each pair's two sides translated at the
closing rate and their difference (zero when they mirror). *Suggested
eliminations* remove the smaller of the two sides from both (so a mirrored
pair disappears entirely and any remainder stays visible to investigate in
the members' books). Eliminations can also be recorded by hand; they must
balance; they are never edited, only voided with a reason. Every change is in
the group's own append-only history.

## Drill-down

Every member figure links to the member accounts behind it, with the
original amount and the rate used, and from there to that member's general
ledger.
