# Verification

## Automated tests

`npm test` runs every Vitest suite against real PostgreSQL (one fresh database
per test file, copied from a template with the migrations applied). They cover
the requirements in the brief, including: balanced postings and exact
decimals; atomicity, concurrency, retries and idempotency; posted-entry
immutability (enforced by the database itself); period locks and reopening;
tenant isolation (including at the foreign-key level) and role permissions;
import deduplication; reconciliation and matching; receivables and payables
agreeing with their control accounts; partial payments, credits, refunds,
deposits and fees; inventory costing; depreciation and disposal; foreign
exchange and revaluation; tax effective dates and rounding; payroll imports;
consolidation and eliminations; cash and accrual policies; report drill-down
and export consistency; backup restoration.

## The synthetic dataset

`lib/demo/dataset.ts` loads four months of a small products business through
the application's own services — the same data a demonstration company gets.
`tests/verification/expected.ts` states the expected balances, cash-basis
balances, open items, stock and sales-tax figures, **worked out by hand** from
the transactions (the arithmetic is beside each figure), and
`tests/verification/dataset.test.ts` checks the application against them.
