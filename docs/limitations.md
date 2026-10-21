# Limitations and what is not verified

What Gideon Books does not do, does differently from what you might expect,
or has not been exercised against the real service. Kept current: when one of
these is addressed, remove it here in the same change.

## External services built but not exercised against a live account

Each has a real adapter, error handling and tests against recorded or
generated responses, a clearly labeled sandbox or local alternative, and a
manual path that works without it.

| Service | Adapter | Verified with | Not verified |
|---|---|---|---|
| Stripe (customer card payments) | `lib/integrations/payments/stripe.ts` | signed sample events, a stubbed API | Checkout sessions and fee lookups against a real Stripe account |
| Stripe Billing (hosted subscriptions) | `lib/hosted/` | signed sample events | subscription checkout and portal against a real account |
| SimpleFIN Bridge (bank feeds) | `lib/banking/feeds/simplefin.ts` | responses shaped like the published protocol | a live bridge |
| SMTP and Resend (email) | `lib/email/send.ts` | a test provider; the outbox | delivery through a real server |
| European Central Bank rates | `lib/fx/providers.ts` | the published XML format | a live fetch in automated tests |
| S3-compatible storage | `lib/storage/storage.ts` | — | any live bucket (the file-system driver is the tested default) |

No live delivery, payment, bank connection or filing was performed while
building this.

## Integrations that do not exist

- **Gideon Keep**: Keep publishes no interface for Books, so there is none.
  Books keeps its own attachments and receipt inbox.
- **Gideon Tax**: no import API exists on the Tax side. Books produces a
  documented, versioned export ([integrations/gideon-tax-export.md](integrations/gideon-tax-export.md), with a JSON Schema) for Tax to read.
- **Payroll providers**: only the documented generic CSV and JSON formats.
  Provider-specific layouts (Gusto, ADP, …) are not built because their
  exports could not be verified; [payroll.md](payroll.md) explains how to add one.
- **Bank file formats**: CSV only; OFX/QFX/QBO are not parsed.

## Accounting scope and choices

- **Sales tax**: no rates ship; taxability is the code you choose; nothing is
  filed. Tax-inclusive prices always round per line.
- **Payroll**: no tax calculation and no filing — imports of what a provider
  calculated.
- **Fixed assets**: straight-line and declining-balance book depreciation,
  full month in the in-service month; disposal requires depreciation posted
  through the prior month. Tax depreciation is entered or computed by simple
  methods; MACRS tables are not implemented.
- **Inventory**: moving weighted average across locations only (no FIFO or
  specific identification); stock may not go negative and movements may not
  be backdated before an item's latest movement. Reorder levels per location
  exist in the schema; the interface sets them per item.
- **Cash basis**: the policy in [accounting/cash-basis.md](accounting/cash-basis.md) — in particular,
  inventory bought on credit is recognized when the bill is paid, and
  credit-to-invoice settlements move no cash and are left out.
- **Consolidation**: translation at the closing rate for balance sheet,
  average rate for income and expense, difference to a translation
  adjustment; equity is not carried at historical rates; consolidation is by
  calendar date range when members' fiscal years differ (a warning shows).
- **Nonprofit and trust reports** support the presentation; they do not
  certify ASC 958 compliance, determine principal versus income under any
  state's law, compute DNI or prepare Form 1041.
- **Settlements** are between items in the same currency; a processor fee is
  recorded on customer payments only.

## Operations

- The Docker image is defined (`Dockerfile`, `docker-compose.yml`) but was not
  built in this environment.
- Browser checks run in Chromium (desktop and a phone viewport); other
  browsers were not tested. There has been no formal WCAG audit.
- The interface is English-only and has a light theme only.
