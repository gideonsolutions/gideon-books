Build Gideon Books into a complete, working accounting application. Implement it now; do not stop at a plan, backlog, prototype, or phased roadmap.

Gideon Books is a full QuickBooks competitor with an Apache-2.0 open-source core, self-hosting, and a hosted Pro offering tentatively around $10/month. Optimize for a complete, coherent product that a small business and its accountant can actually use.

Inspect the repository and its instructions first. Reuse the existing stack, architecture, components, authentication, and integrations where appropriate. Preserve unrelated work. If the repository is empty, choose a maintainable stack and proceed. Make reasonable decisions autonomously; ask only genuinely blocking questions.

Work continuously through implementation, migrations, UI, integrations, tests, documentation, and verification. Internal task ordering is fine, but do not split delivery into phases or defer requested functionality merely to produce an MVP. Do not substitute mock screens, placeholder buttons, TODOs, or implementation plans for working features.

## Product boundaries

- Gideon Books owns accounting transactions, balances, financial reporting, reconciliation, and period close.
- Gideon Keep owns supporting records and receipts where that integration exists. Books must still support attachments independently.
- Gideon Tax owns tax computation, return preparation, and filing. Books supplies traceable accounting data and separate tax adjustments.
- Keep the core self-hostable without proprietary hosted services.
- Do not silently relicense third-party code or incompatible existing code. Apply Apache-2.0 to project-owned code where authorized.

## Accounting foundation

Implement:

- Multiple organizations, organization settings, fiscal years, periods, base currency, and chart-of-accounts templates.
- Account types, subaccounts, account codes, archived accounts, and opening balances.
- Balanced double-entry journals, journal lines, descriptions, attachments, counterparties, dimensions, and source references.
- Exact decimal arithmetic with explicit currency precision and rounding rules. Never use binary floating-point for accounting calculations.
- One shared posting engine used by every module.
- Atomic posting, transaction-safe concurrency, and persistent idempotency.
- Editable drafts and immutable posted financial entries.
- Linked reversals, credit documents, and adjustments for corrections.
- Period locks, authorized reopening, and auditable close workflows.
- Audit history recording organization, actor, timestamp, action, source, and reason.
- Constraints preventing cross-organization references and invalid account usage.

Distinguish document dates, posting dates, service dates where relevant, payment dates, and fiscal periods.

## Banking and reconciliation

Implement:

- Bank, credit-card, cash, and clearing accounts.
- CSV imports with column mapping, preview, validation, reusable mappings, and duplicate detection.
- Preservation of original import data and import-batch provenance.
- Bank-feed integration through a provider abstraction.
- Separate imported bank observations from ledger postings.
- Suggested and manual matching, including split transactions, transfers, fees, refunds, and many-to-one or one-to-many matches.
- Reconciliation against statement dates and balances.
- Explicit handling of outstanding items, discrepancies, and reconciliation corrections.
- Categorization rules with preview, precedence, review controls, and audit history.

Never automatically post uncertain classifications without the applicable user permission and configuration.

## Sales and accounts receivable

Implement:

- Customers and contacts.
- Products and services.
- Estimates, conversion to invoices, invoices, recurring invoices, credit notes, customer statements, and aging.
- Draft, issued, partially paid, paid, overdue, and void/corrected document states with valid transitions.
- Due dates, payment terms, discounts, shipping, line-level taxes, and configurable numbering.
- Partial payments, payments covering multiple invoices, deposits, unapplied credits, refunds, and write-offs.
- Downloadable invoice PDFs and configurable business branding.
- Email delivery through a configurable provider with delivery history.
- Payment-provider integration with safe webhook handling and separate accounting for gross receipts, fees, refunds, and settlements.

Receivables must reconcile to the general ledger.

## Purchases and accounts payable

Implement:

- Vendors, purchase orders, bills, vendor credits, recurring bills, expenses, and expense reimbursements.
- Partial payments, payments covering multiple bills, prepayments, and refunds.
- Attachments and receipt matching.
- Due-date tracking, aging, and payment-status tracking.
- Purchase-order receipt and bill matching where inventory is involved.

Recording a payment must not silently initiate an actual money transfer. External money movement requires a separately configured integration and explicit authorization.

Payables must reconcile to the general ledger.

## Inventory

Implement:

- Stock and non-stock items, units, locations, opening stock, receipts, sales, returns, transfers, and adjustments.
- Inventory valuation and cost-of-goods-sold postings.
- A documented, consistently applied costing method.
- Reorder levels and stock reports.
- Explicit rules for negative inventory, backdated changes, and corrections.
- Reconciliation between inventory valuation and ledger control accounts.

Prevent invalid operations rather than silently producing incorrect costs.

## Fixed assets

Implement:

- Asset register, acquisition, capitalization, useful life, residual value, depreciation schedules, accumulated depreciation, disposal, and gains or losses.
- Automated depreciation journals with review and idempotent posting.
- Separation of book depreciation from tax depreciation adjustments.
- Asset reports reconciling to the ledger.

## Projects, dimensions, and budgets

Implement:

- Projects, classes, departments, and locations as appropriate to the existing architecture.
- Dimension assignment at transaction-line level.
- Project income, costs, profitability, and billable time/expenses.
- Budgets by period and account, with optional dimensions.
- Actual-versus-budget reporting.

## Multicurrency

Implement:

- Organization base currency and foreign-currency customers, vendors, accounts, and documents.
- Stored transaction exchange rates and their provenance.
- Original-currency and base-currency amounts.
- Settlement differences, realized gains/losses, and period-end unrealized revaluation.
- Revaluation reversals and explicit rounding treatment.
- Configurable exchange-rate provider plus manual rates.

Historical postings must not change when exchange rates are updated.

## Sales tax

Implement:

- Configurable jurisdictions, rates, effective dates, exemptions, inclusive/exclusive pricing, and compound taxes where supported.
- Tax calculation details retained with each document.
- Tax liability reports, adjustments, and recorded remittances.
- Clear separation between configurable accounting support and jurisdiction-specific filing automation.

Do not claim universal tax compliance. Do not fabricate rates or silently use current rates for historical transactions.

## Payroll integration

Implement a complete payroll-import and accounting workflow:

- Provider adapters and a documented generic import format.
- Payroll runs, gross wages, employer taxes, employee withholdings, benefits, reimbursements, liabilities, and cash settlement.
- Mapping previews, validation, balanced posting, duplicate protection, corrections, and reconciliation.
- Payroll summaries and liability reporting.

The required scope is payroll integration and accounting, not a newly invented payroll tax calculation or payroll filing engine.

## Multi-entity and specialized accounting

Implement:

- Accountant access across multiple organizations.
- Entity groups, account mappings, intercompany balances, elimination entries, and consolidated reporting.
- Explicit handling of differing currencies and fiscal periods.
- Fund/restricted-fund tracking for nonprofit accounting.
- Trust/estate dimensions for principal versus income, beneficiaries, distributions, and supporting reports.
- Configurable mappings and clear boundaries between accounting records and jurisdiction-specific legal or tax determinations.

Do not advertise statutory reports as compliant without implementing and verifying the relevant rules.

## Financial reporting

Implement:

- General ledger.
- Trial balance.
- Balance sheet.
- Profit and loss.
- Cash-flow statement.
- Comparative periods.
- Accounts receivable and payable aging.
- Customer and vendor balances.
- Inventory valuation.
- Fixed-asset rollforward.
- Sales-tax liabilities.
- Project profitability.
- Budget comparisons.
- Dimension and entity reporting.
- Consolidated statements.

Every total must drill down to underlying transactions. Reports must use consistent date boundaries, posting status, organization scope, currency treatment, and accounting basis.

Support accrual and cash-basis reporting with an explicit, tested transformation policy. Do not implement cash basis by merely filtering on payment dates. Correctly address partial payments, credits, prepayments, inventory, and transactions outside receivables/payables.

Provide CSV and PDF exports.

## Gideon Tax integration

Implement:

- Versioned mappings from accounts and dimensions to tax categories.
- A separate tax-adjustment layer that does not rewrite book accounting.
- Reviewable book-to-tax reconciliations.
- Export packages with period, source balances, adjustments, mapping version, and provenance.
- An integration adapter for Gideon Tax where its actual contract exists.
- A documented, machine-readable export contract otherwise.

Do not invent a working integration with an API you have not inspected.

## User experience

Build a polished, responsive application with:

- Dashboard showing useful financial summaries and actionable items.
- Clear navigation across banking, sales, purchases, accounting, inventory, assets, projects, reports, and settings.
- Search, filters, sorting, pagination, and useful empty states.
- Accessible forms, keyboard operation, validation, and error recovery.
- Consistent money/date formatting and organization context.
- Safe document-state transitions and confirmations for consequential actions.
- Useful loading states and background-job status.
- A complete onboarding flow covering organization setup, accounts, opening balances, and imports.
- Clearly labeled demonstration data that never mixes with real books.

All visible actions must work. Surface provider configuration requirements clearly.

## Security and operations

Implement:

- Authentication using the existing system where available.
- Organization-scoped authorization with owner, administrator, accountant, staff, and read-only roles.
- Server-side enforcement of permissions.
- Isolation across queries, attachments, exports, jobs, and integrations.
- Secure secrets handling and redaction.
- Attachment validation and controlled downloads.
- Webhook verification and replay protection.
- Durable jobs with retries and idempotent effects.
- Database migrations and documented deployment.
- Health checks, structured logs, and useful operational errors.
- Backups and a verified restoration procedure.
- Complete data export and documented import formats.
- Reproducible self-hosted setup, including containers if appropriate for the stack.

Provide an API with validation, authentication, authorization, pagination, idempotency where needed, and documentation.

## Hosted offering

Keep hosted-service concerns separate from the accounting core.

Implement plan configuration, usage metering, and integration points for hosted billing where supported by the repository. Treat $10/month as a tentative configurable price, not a hard-coded promise. Make usage limits explicit for cost-bearing services such as bank feeds, document processing, storage, and email.

Core bookkeeping and access to existing records must not depend on a proprietary service being available.

## External dependencies

If credentials or external accounts are unavailable:

- Implement the real adapter, configuration, error handling, and test coverage.
- Supply a local test adapter or sandbox mode that is clearly labeled.
- Keep the corresponding manual/import workflow functional.
- Report exactly what remains unverified.
- Do not claim that live delivery, banking, payments, or tax filing succeeded.

Do not purchase services, deploy to production, send real customer messages, move money, or file returns without explicit authorization.

## Verification

Write and run meaningful automated tests for:

- Balanced postings and exact decimal calculations.
- Atomicity, concurrent requests, retries, and idempotency.
- Posted-entry immutability and correction workflows.
- Period locks and authorized reopening.
- Tenant isolation and role permissions.
- Import deduplication.
- Reconciliation and matching.
- Receivables/payables agreeing with ledger control accounts.
- Partial payments, credits, refunds, deposits, and fees.
- Inventory costing and valuation.
- Depreciation and asset disposal.
- Foreign exchange and revaluation.
- Tax effective dates and rounding.
- Payroll imports.
- Consolidation and eliminations.
- Cash/accrual reporting policies.
- Report drill-down and export consistency.
- Backup restoration.

Run end-to-end browser checks for the main workflows. Inspect the actual rendered UI and fix broken layouts or interactions.

Create a synthetic accounting dataset spanning multiple periods. It must exercise sales, bills, payments, refunds, fees, owner contributions/draws, inventory, assets, taxes, foreign currency, and period close. Establish expected accounting outcomes independently of the implementation, then verify the application against them.

## Completion requirements

Deliver working code, migrations, tests, deployment configuration, and documentation in the repository.

Do not end after producing a plan or scaffolding. Continue implementing and fixing until the requested functionality is complete or a concrete external blocker prevents further progress.

Do not call incomplete work complete. If execution limits prevent finishing, preserve a precise checklist of remaining work and report the actual state.

At the end, give a concise summary of:
- What was implemented.
- How to run it.
- Which checks passed and which failed.
- Required external configuration.
- Any remaining limitations, with exact scope.

Begin by inspecting the repository, then build the application.
