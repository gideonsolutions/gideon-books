# Multiple currencies

- The organization keeps its books in its **base currency**, fixed once
  anything is posted.
- Customers and vendors can have their own currency; documents and payments
  are in that currency. Bank, cash, clearing and credit-card accounts can be
  held in a foreign currency (every line on them is in that currency).
- **Rates** are base-currency units per one foreign unit. They come from the
  configured provider (the European Central Bank's reference rates by
  default) or are entered by hand; a rate typed on a single transaction is
  stored as its own row. Every posting line stores the rate it used and the
  id of the rate row (its provenance). Rates are never edited once used, so
  **updating rates never changes a historical posting**. The rate for a date
  is the latest one on or before it, at most seven days old; an older one is
  refused rather than silently used.
- Each line carries its original-currency amount and its base amount.
- **Realized gain or loss**: when a payment settles a document, each side is
  relieved at its own historical base value (in full on the final
  settlement, pro rata before it) and the difference posts to Realized
  Exchange Gain/Loss on the settlement date. A payment into a base-currency
  bank account records the amount actually received, which sets the rate.
- **Unrealized gain or loss**: at period end, *Revalue* restates open
  foreign receivables, payables, deposits, prepayments and foreign money
  accounts at that date's rate, posting the difference to Unrealized Exchange
  Gain/Loss as an adjusting entry that **reverses automatically the next
  day**, so later settlements still measure from the historical rate. The
  receivable/payable part is excluded from cash-basis reports.
- Rounding: conversion is half-up per line; see rounding.md.
