# Projects and time

Code: `lib/projects/`. Pages under `/o/<org>/projects`.

## Projects

A project has a customer (required unless it is internal), a billing method (time and materials, fixed fee, or not billable), a default hourly rate, an optional fixed fee, a cost budget and dates. Any invoice, bill, expense or journal line can carry the project as a dimension.

**Profitability** (project page, accrual basis): income = credits to income accounts on lines tagged with the project; costs = debits to expense accounts (cost of goods sold and other expenses); profit, margin, and costs against the budget. Each figure links to the general ledger filtered by account and project.

## Time

`/projects/time`: time entries (date, who — a member or an employee contact — project, hours to two places, rate, billable, description), a weekly sheet (Monday to Sunday, by project and day) and a filterable list. A billed entry cannot be edited or deleted; staff may change only their own entries.

## Billable expenses

A bill or expense line with a project and **Billable to** customer is a billable expense of that project once the bill is posted.

## Billing a project

`/projects/<id>/bill`: choose unbilled billable time (hours × the entry's rate, else the project's rate) and billable expenses (at cost plus an optional markup), plus an optional fixed-fee or milestone line, and an income account. A **draft invoice** is created for the project's customer, every line tagged with the project; edit it and issue it from Sales as usual.

Each time entry and expense line billed is linked to the invoice (`project_billing_links`), with a unique index so the same work is never on two live invoices, even if two people bill at once (the second draft is withdrawn). Deleting the draft releases the work; voiding the invoice releases it the next time the project is billed. Expenses in a currency other than the customer's are not billed automatically.
