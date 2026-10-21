# Sales and receivables

Everything customers owe and pay: estimates, invoices, credit notes,
write-offs, sales receipts, payments, deposits, refunds, recurring invoices
and statements. The accounting lives in `lib/commerce` (shared with
purchases); this module (`lib/sales`, `components/sales`,
`app/o/[org]/sales`) is the sales-side service and UI around it.

## Documents and their states

| kind | posts | states |
|---|---|---|
| Estimate | nothing | draft → sent → accepted / declined / expired → converted |
| Invoice | Dr receivables, Cr income and tax (deferred on the cash basis) | draft → issued → partially paid → paid; void |
| Credit note | Dr income and tax, Cr receivables | draft → issued → closed (fully applied); void |
| Write-off | Dr bad debt, Cr receivables; applied to its invoice at once | issued → closed |
| Sales receipt | Dr the deposit account, Cr income and tax | draft → recorded (paid); void |

*Overdue* is never stored: an issued or partially paid invoice past its due
date shows as overdue (`displayStatus`). Valid transitions are in
`lib/commerce/states.ts`.

- Drafts can be edited and deleted. Issuing numbers the document from its
  sequence, recomputes tax with the rates in effect on its document date,
  converts at the rate for its posting date, posts it, and (for stock items)
  relieves stock at average cost with a separate cost-of-goods entry.
- An issued document never changes (the database refuses). It is corrected
  by a credit note (from the invoice: “Credit note”, whose lines carry the
  original line so returned stock comes back at its original cost) or voided.
- Voiding reverses everything the document posted, on the void date. It is
  refused while payments or credits are applied: remove those first (each
  removal is itself a reversing entry with a reason), or issue a credit note.

## Payments, deposits, credits, refunds

`Sales → Payments received → Receive payment` records money and applies it
to any number of open invoices, in part or in full. Whatever is not applied
stays an **unapplied credit** on the customer, shown on their page, applied
later from an invoice (“Apply a credit”) or refunded.

- **Deposits** taken before invoicing are held in *Customer deposits* (a
  liability) until applied to an invoice.
- **Credit notes** are applied to invoices or refunded.
- **Refunds** pay a credit back; recording one does not send money.
- **Fees** withheld by a processor are recorded on the payment: the
  deposit is gross less fee, and the fee is an expense.
- **Write-offs** close what is left on an invoice as bad debt. Sales tax on a
  written-off invoice is not reduced automatically; record a sales-tax
  adjustment where the jurisdiction allows a bad-debt deduction.
- **Foreign currency**: payments are in the invoice's currency; a payment
  into a base-currency account can state the base amount that arrived, which
  sets the rate. Each application relieves the invoice at its own historical
  rate and books the difference to realized exchange gain or loss.

Each application is a *settlement* posting its own entry; the customer's
receivable is the sum of the ledger lines tagged with their documents and
payments, so the subledger and the ledger always agree.

## Recurring invoices

A template (an invoice without dates plus a schedule) makes one invoice per
occurrence, dated the occurrence date, left as a draft or issued (and
optionally emailed with its PDF). Occurrences are anchored on the start date
(31 January monthly gives 28/29 February, then 31 March).

Each occurrence is made **exactly once**: the template row is locked while an
occurrence is made, occurrences are recorded in `recurring_runs` (unique per
template and date), and a document left by a run that crashed before
recording itself is found by template and date instead of being made again.
A failed occurrence is recorded with its error and retried on the next run;
the schedule only advances past occurrences that were made.

The worker runs job **`sales.recurring`** (`lib/sales/jobs.ts`), which calls
`runDueRecurring(today?, orgId?)` from `lib/sales/recurring.ts`. The
scheduler should enqueue it daily (dedupe key per day); “Run now” on a
template runs it for that template immediately.

## Statements

`Customers → (customer) → Statement` shows the opening balance, every charge
and credit in the range, the closing balance and the open items by age, in
the customer's currency, from the receivable and deposit lines tagged with
the customer — so the closing balance is the ledger's. Settlement entries
(which move nothing in the customer's currency) are not listed. PDF and email
are available.

## PDFs, branding and email

Invoices, estimates, credit notes, sales receipts and statements render as
PDFs (`lib/sales/pdf.ts`, on `lib/pdf/core.ts`) with the organization's
branding (`Settings → Invoice branding`: logo, accent color, address, payment
instructions, footer). A document keeps the branding it was issued with.

Emailing attaches the PDF (stored as a generated attachment on the document)
and queues the message; its delivery history shows on the document. With the
default `EMAIL_PROVIDER=outbox` nothing is delivered and the page says so.

## Online payments

See `docs/integrations/payments.md`.
