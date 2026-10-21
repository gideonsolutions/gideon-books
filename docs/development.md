# Developing Gideon Books

## Layout

| path | what |
|---|---|
| `lib/money` | `Decimal` (exact arithmetic), currencies and minor units, display formatting |
| `lib/db` | Drizzle schema (one file per module under `schema/`), the client, generated migrations, hand-written integrity SQL (`sql/integrity*.sql`) |
| `lib/ledger` | Chart of accounts, fiscal periods and close, **the posting engine**, manual journals, opening balances, dimensions |
| `lib/commerce` | Sales and purchase documents, payments, settlements (open items), cash-basis projection |
| `lib/inventory` | Stock ledger and moving-average costing |
| `lib/tax` | Sales-tax configuration, calculation, remittances |
| `lib/fx` | Exchange rates, providers, revaluation |
| `lib/<module>` | One directory per module (banking, sales, purchases, assets, payroll, projects, reports, taxexport, consolidation, hosted, ops) |
| `lib/auth`, `lib/authz` | Accounts, sessions, two-step, API tokens; roles and permissions |
| `lib/jobs` | Durable job queue; `handlers.ts` registers each module's `jobs.ts` |
| `lib/api` | REST API plumbing (`apiHandler`) |
| `lib/web` | Server-side helpers for pages and server actions |
| `app/o/[org]/…` | Organization pages (server components), `actions.ts` server actions per area |
| `components/ui.tsx` | Server-safe UI primitives; `components/client/*` interactive pieces |
| `tests/` | Vitest against real Postgres |

## Rules the code keeps

1. **Exact money.** `Decimal.from("12.34")`; never `Number(amount)` for arithmetic. Amounts are stored as `numeric` and read as strings. A value with more places than its currency is refused, not rounded, unless the rounding is the point of the calculation (tax, conversion, allocation) — then it is half-up at the currency's minor units, once, documented at the call site.
2. **One posting engine.** Build `LineInput[]` (signed: debit positive) and call `postEntry(tx, ctx, {...})` inside `withTransaction`. Pass `idempotencyKey` for anything a retry could repeat. Pass `allowControlAccounts: true` only from a subledger module that tags `openItem` and `contactId` on receivable/payable/deposit/prepayment lines. Set `cashBasis` (`as_is`, `deferred` for receivable/payable documents, `settlement`).
3. **Corrections are new records.** Never update or delete a posted entry, stock move, settlement, payment amount, issued document or audit event (the database refuses). Use `reverseEntryInternal`, `reverseMove`, `reverseSettlement`, voids and credit documents.
4. **Context and permission.** `requirePermission(ctx, "…")` at the top of every service that changes something; reads check `ledger.read`/`reports.read` etc. where the page does not already. Never trust an id from the client without `eq(table.orgId, ctx.orgId)`.
5. **Audit.** `audit(tx, ctx, { action: "module.verb", entityType, entityId, reason?, before?, after?, metadata? })` in the same transaction.
6. **Errors people can act on.** Throw `ValidationError(message, fields)`, `ConflictError(message, code)`, `NotFoundError`, `ForbiddenError`, `PostingError`. Messages are full sentences that say what to do.
7. **Dates are ISO strings** (`lib/dates.ts`), never `Date` objects, for accounting dates. Distinguish document date, posting date, service date, payment date.
8. **Providers are optional.** Every external integration has a real adapter, a clearly labeled sandbox/local adapter, and a manual path that works without it. Demonstration organizations (`org.isDemo`) only ever use sandboxes. Recording a payment never moves money.

## UI conventions

- Pages are server components: `const ctx = await orgCtx(params.org)`, load with service/read functions, render with `components/ui.tsx`.
- Forms post to server actions (`"use server"` files) wrapped in `runAction(...)`, rendered with `ActionForm`, `TextField`, `SelectField`, `SubmitButton` from `components/client/forms.tsx`. Field errors map by input `name`.
- Consequential actions (void, reverse, close, delete) use `ConfirmButton`, with `reasonLabel` when a reason is required.
- Lists: `FilterBar` (GET form) + `Table`/`SortTh` + `Pagination`, URL search params as state, an `EmptyState` that says what to do.
- Money: `<Money amount currency />`; dates: `<DateText date />`. Every total links to the report or general ledger rows behind it.
- Canonical record URLs: `/o/<org>/documents/<id>` and `/o/<org>/payments/<id>` redirect to the page for the kind (`lib/web/routes.ts`); entries link to sources through `lib/web/links.ts`.

## Database changes

Edit the module's file under `lib/db/schema/`. While developing, run tests with `TEST_SCHEMA_SOURCE=push`. Before a release (and before CI), regenerate migrations: `bash scripts/regen-migrations.sh` (pre-1.0, rebuilds the single initial migration) — after 1.0, `npm run db:generate` adds an incremental one. Triggers and other SQL Drizzle cannot express go in `lib/db/sql/integrity-<module>.sql`, separated by `--> statement-breakpoint`.

## Tests

`bash scripts/test.sh tests/<area>` runs Vitest against a fresh copy of a migrated template database per test file (Postgres from `docker compose up -d db`, or set `TEST_DATABASE_URL`). Helpers in `tests/helpers.ts`: `setupOrg()`, `customer()`, `vendor()`, `stockItem()`, `balance()`, `rejectsWith()`, `rejectsDb()`.
