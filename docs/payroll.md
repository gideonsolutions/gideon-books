# Payroll

Code: `lib/payroll/`. Pages under `/o/<org>/payroll`. File format: [payroll-import-format.md](payroll-import-format.md).

Gideon Books is the books for payroll, not the payroll engine: it imports what a payroll provider calculated, checks it, posts it, and tracks what is still owed. It does **not** calculate wages or payroll taxes, file payroll returns, or pay anyone.

## Flow

1. **Import** (`/payroll/import`): upload or paste a file in the documented CSV or JSON format.
2. **Preview** (`/payroll/imports/<id>`): every problem is listed before anything posts — unreadable rows, amounts with too many decimal places, an employee whose net pay does not equal gross − withholdings − deductions + reimbursements, a component with no mapping, an unknown department/class/location/project, a pay date in a closed period, or a run or file already posted. The page shows the exact entry that will post.
3. **Post**: validated again with the current mappings, then posted as one balanced entry on the pay date (kind `payroll`, source `payroll_run`), idempotent per import. The run keeps its per-employee detail and a snapshot of the mappings it used.

## The entry

Debits: gross wages, employer taxes, employer benefits and reimbursements to their expense accounts, with the employee's department, class, location and project. Credits: withholdings, deductions and employer taxes and benefits to their liability accounts, and net pay to net pay clearing (or straight to a bank account if mapped so). Lines are summed per account and dimension.

## Mappings

`/payroll/mappings`: each component type has a default (`*`) created from the system accounts — Wages and Salaries, Payroll Taxes, Employee Benefits, Payroll Liabilities, Net Pay Clearing; reimbursements default to Uncategorized Expense and should be mapped. A specific code (e.g. `employer_tax / futa`) can have its own accounts. Every change is audited.

## Settlement

On a run's page: **record net pay disbursed** (Dr net pay clearing, Cr bank — defaults to what is outstanding) and **record liability payments** (tax deposits, benefit remittances: Dr liability, Cr bank). Liability payments can also be recorded without a run on the reports page. These record payments made elsewhere; they never move money. Each can be voided (reversal with a reason).

## Corrections and duplicates

A run (format + run id) or a file (SHA-256) posts once while it stands. Void a run (reason required; its payments must be voided first) and import the corrected file. Posting is serialized per organization, so two simultaneous imports of the same run post once.

## Reports and reconciliation

`/payroll/reports`: the payroll summary for a date range (by component, employer cost by department and by project) and the **liability report** — for each payroll liability account: opening, accrued by runs, paid, other postings, owed at the end — compared with the ledger balance, with any difference shown.

The period-close checklist warns about imports waiting to be posted with a pay date in the period, and about net pay clearing not cleared at the period end.

## Unverified

No payroll provider API or provider-specific export format is integrated or verified. The generic CSV/JSON formats are the integration point.
