# Gideon Books

Double-entry accounting for a small business and its accountant — from the
first invoice to the period close. The core is open source under the
[Apache License 2.0](LICENSE) and runs on your own server with nothing but
PostgreSQL; a hosted Pro offering is planned (tentatively about $10 a month,
configurable, see [docs/hosted.md](docs/hosted.md)).

Part of the Gideon family: **Gideon Books** keeps the books; **Gideon Keep**
keeps supporting records and receipts; **Gideon Tax** computes and files
taxes. Books hands Tax traceable accounting data through a documented export
([docs/integrations/gideon-tax-export.md](docs/integrations/gideon-tax-export.md)).

## What it does

- **Ledger** — multiple organizations, fiscal years and monthly periods, chart-of-accounts templates (services, products, nonprofit, trust/estate), subaccounts, archived accounts, opening balances; balanced double-entry journals with dimensions, contacts, attachments and source references; one posting engine for every module; editable drafts, immutable posted entries, linked reversals; period close with a checklist, locks and audited reopening; an append-only audit trail. ([docs/accounting/posting.md](docs/accounting/posting.md))
- **Exact money** — decimals end to end, currency precision enforced, every rounding rule explicit. ([docs/accounting/rounding.md](docs/accounting/rounding.md))
- **Banking** — bank, card, cash and clearing accounts; CSV import with mapping, preview, validation, reusable mappings, duplicate detection and provenance; bank feeds through a provider abstraction (SimpleFIN, sandbox); matching (split, transfer, fee, refund, many-to-one, one-to-many); reconciliation against statements; rules with preview, precedence and review. ([docs/banking.md](docs/banking.md))
- **Sales** — customers, products and services, estimates → invoices, recurring invoices, credit notes, sales receipts, statements, aging; partial and multi-invoice payments, deposits, unapplied credits, refunds, write-offs; PDFs with your branding; email with delivery history; card payments through a provider with gross, fee, refund and payout accounted separately. ([docs/sales.md](docs/sales.md))
- **Purchases** — vendors, purchase orders with receiving and three-way matching, bills, vendor credits, recurring bills, expenses and employee reimbursements, receipts; payments that record but never move money. ([docs/purchases.md](docs/purchases.md))
- **Inventory** — stock and non-stock items, locations, receipts, sales, returns, transfers and adjustments at moving weighted-average cost, reconciled to the ledger; negative stock and backdating refused. ([docs/accounting/inventory.md](docs/accounting/inventory.md))
- **Fixed assets** — register, capitalization, straight-line and declining-balance schedules, reviewed idempotent depreciation runs, disposals with gain or loss, a separate tax book, a rollforward that reconciles. ([docs/accounting/fixed-assets.md](docs/accounting/fixed-assets.md))
- **Projects, dimensions, budgets** — classes, departments, locations, funds and projects on every line; time and billable expenses; profitability; budgets by period with actual-versus-budget.
- **Multiple currencies** — foreign customers, vendors, accounts and documents; stored rates with provenance; realized and unrealized gains and losses; automatic reversal. ([docs/accounting/multicurrency.md](docs/accounting/multicurrency.md))
- **Sales tax** — jurisdictions, dated rates, compound and inclusive taxes, exemptions, the computation kept with each document, liability reports and recorded remittances — and no claim of universal compliance. ([docs/accounting/sales-tax.md](docs/accounting/sales-tax.md))
- **Payroll integration** — a documented import format and adapters, mapping preview, validation, balanced posting, duplicate protection, corrections, liability reporting; no payroll tax engine. ([docs/payroll.md](docs/payroll.md))
- **Multi-entity** — accountants across many organizations, entity groups, account mappings, intercompany balances, eliminations and consolidated statements with currency translation; nonprofit funds and trust principal/income. ([docs/consolidation.md](docs/consolidation.md), [docs/accounting/funds-and-trusts.md](docs/accounting/funds-and-trusts.md))
- **Reports** — general ledger, trial balance, balance sheet, profit and loss, cash flow, comparatives, aging, contact balances, inventory valuation, asset rollforward, sales-tax liability, project profitability, budgets, dimension and consolidated reports, on the accrual or cash basis; every figure drills down to its transactions; CSV and PDF exports. ([docs/accounting/cash-basis.md](docs/accounting/cash-basis.md), [docs/accounting/reports.md](docs/accounting/reports.md))
- **API** — REST with tokens, roles, validation, pagination and idempotency keys; OpenAPI at `/api/v1/openapi.json`, reference at `/api-docs`. ([docs/api.md](docs/api.md))

What it does not do, and which outside services have not been exercised
against a live account: [docs/limitations.md](docs/limitations.md).

## Run it

### With Docker (self-hosting)

```sh
cp .env.example .env        # set BOOKS_ENCRYPTION_KEY and APP_URL at least
docker compose up -d        # PostgreSQL, migrations, the app and the worker
open http://localhost:3200  # the first account created is the instance administrator
```

Everything about running it for real — TLS, email, storage, backups and the
verified restore procedure, upgrades, health checks — is in
[docs/self-hosting.md](docs/self-hosting.md) and
[docs/operations.md](docs/operations.md).

### For development

```sh
npm ci
docker compose up -d db                 # PostgreSQL on localhost:54329
cp .env.example .env.local              # and set BOOKS_ENCRYPTION_KEY
npm run db:migrate
npm run dev                             # http://localhost:3200
npm run worker                          # background jobs (email, recurring, feeds, …)
npm run db:seed-demo -- --email you@example.com --password '…'   # a demonstration company
```

### Checks

```sh
npm run typecheck
npm run lint
npm test               # Vitest against real PostgreSQL (TEST_DATABASE_URL)
npm run test:e2e       # Playwright browser checks of the main workflows
npm run build
```

[docs/verification.md](docs/verification.md) describes the test suites and
the synthetic dataset whose expected results are worked out by hand.

## Working on the code

[docs/development.md](docs/development.md): layout, the rules the code keeps
(exact money, one posting engine, corrections as new records, server-side
permissions, audit), UI conventions and database changes.

## License

Apache-2.0 for the code in this repository — see [LICENSE](LICENSE) and
[NOTICE](NOTICE). The Gideon mark in `public/brand/` is not covered: it is
under the Gideon Christian Open Source License and is a trademark of Gideon
Solutions, LLC; replace it if you distribute a modified version.
