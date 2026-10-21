# Sales tax

Gideon Books records and reports sales tax; it does not decide what is
taxable, ship rates, or file returns.

## Configuration

- **Jurisdictions** — each authority you collect for, with the liability
  account the tax is owed to, optionally a recoverable account (for
  VAT-style input tax; without one, tax on purchases is part of the cost),
  the authority as a vendor, and filing frequency.
- **Rates** — each with its effective dates and a note of where the rate came
  from. Rates for one jurisdiction cannot overlap; adding a new open-ended
  rate ends the current one the day before. A rate used by a document is
  never edited or deleted. **No rates ship with the software.**
- **Tax codes** — one or more jurisdictions in order; a component can be
  *compound* (taxing the net plus the taxes before it). An exempt code
  records the line with no tax.
- **Exemptions** — a customer marked tax-exempt (with a reason and
  certificate number) has every line recorded as exempt sales.

## On a document

The rate is the one **in effect on the document date**. If a code has no
rate covering that date the document is refused — it is never taxed at
today's rate instead. Each line keeps its own copy of the computation:
jurisdiction, rate row, the rate as applied, taxable base, tax, compound
flag, recoverable flag and exemption (`document_line_taxes`). Changing rates
later changes nothing already issued.

Prices can be tax-exclusive or tax-inclusive per document. Rounding is per
line or per document (see rounding.md).

## Liability, adjustments and remittances

Collected tax posts to each jurisdiction's liability account. The
sales-tax liability report shows, for a period and jurisdiction, taxable and
exempt sales, tax collected, recoverable tax, adjustments, remittances and
the balance owed, all reconciled to the ledger. **Record a remittance** when
you pay the authority (it records the payment; nothing is sent). **Adjust**
for a timely-filing discount, a correction or a penalty, with a reason.

Filing the return is done with the authority, or through Gideon Tax where it
supports that return. Gideon Books makes no claim of compliance with any
jurisdiction's rules.
