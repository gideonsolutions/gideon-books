<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Gideon Books — working in this repository

Read `docs/development.md` before changing code. The short version:

- **Money is `Decimal`** (`lib/money/decimal.ts`): strings in, strings out, never a JavaScript float. Round only with an explicit mode, at the currency's minor units (`lib/money/currency.ts`).
- **Every posting goes through `postEntry`** (`lib/ledger/posting.ts`), inside the caller's transaction. Posted entries are immutable (database triggers); corrections are reversals.
- **Every service function takes a `Ctx`** (`lib/context.ts`) first, calls `requirePermission`, scopes every query by `ctx.orgId`, and writes an `audit` event in the same transaction.
- **Every org-owned table** has `org_id` and references other org-owned rows with composite `(org_id, id)` foreign keys (`lib/db/schema/_columns.ts`).
- Tests: `bash scripts/test.sh <paths>` (real Postgres; `TEST_SCHEMA_SOURCE=push` while the schema is changing). Type-check with `bash scripts/typecheck.sh`.
