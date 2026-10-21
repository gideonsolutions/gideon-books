# Nonprofit funds; trusts and estates

## Funds

A fund is a dimension value of kind `fund` carrying its donor restriction:
without donor restrictions, with donor restrictions (purpose or time), or
with donor restrictions (perpetual). Tag contribution, grant and expense
lines with the fund. Lines without a fund belong to net assets without donor
restrictions.

A fund's **net assets** are minus the sum of its lines on equity, income and
expense accounts. Because every entry balances, the funds always add up to
total assets minus total liabilities (the reports show the check).

Reports (Reports → Funds):

- **Statement of activities** for a period: revenue and expenses by
  restriction class (and by fund), net assets released from restriction, and
  the change in net assets per class.
- **Fund balances**: opening, revenue, expenses, releases, closing per fund.
- **Net assets by restriction** at a date.

**Releasing from restriction** (purpose met or time elapsed) posts
Dr Net Assets With Donor Restrictions (in the restricted fund) /
Cr Net Assets Without Donor Restrictions (in the chosen unrestricted fund or
none), with the reason recorded in the audit trail. It refuses to release
more than the fund holds on that date, and refuses perpetual restrictions.

Expenses tagged with a restricted fund appear in that class. The usual
presentation (ASC 958) reports all expenses without donor restrictions and
shows releases; to present it that way, tag expenses accordingly and record
releases.

These reports support the nonprofit presentation. They are not a certification
of compliance with GAAP (ASC 958), the Form 990, or any regulator's
requirements.

## Trusts and estates

Every journal line can say which side of the trust it belongs to
(`trust_component`: principal or income) and which beneficiary it concerns.

Reports (Reports → Trusts & estates):

- **Principal and income**: receipts (income accounts), disbursements
  (expense accounts) and distributions for a period, principal and income
  side by side, with lines not yet marked shown separately.
- **Distributions by beneficiary**, by component, with the entries behind
  them.
- **Undistributed income**: income receipts less income disbursements less
  income distributions, for the period and to date.

**Recording a distribution** posts Dr Distributions to Beneficiaries /
Cr the account paid from, both tagged with the beneficiary and the component.
It records a payment that was made; it does not pay anyone.

What Gideon Books does **not** do: decide whether a receipt or disbursement
belongs to principal or income under any state's principal-and-income act
(the fiduciary records it); compute distributable net income or the
distribution deduction; prepare or file Form 1041 or any state fiduciary
return. Gideon Tax receives the accounting data through its export; tax
determinations belong there.
