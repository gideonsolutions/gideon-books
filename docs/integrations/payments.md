# Card payments (payment providers)

Customers can pay an issued invoice through a **payment link** at the
organization's connected provider. Gideon Books never initiates a transfer:
the customer pays on the provider's own checkout, and the books record what
the provider reports.

## Providers

| provider | what it is | needs |
|---|---|---|
| **Stripe** (`lib/integrations/payments/stripe.ts`) | The organization's own Stripe account, through the REST API (no SDK) | A secret or restricted key and a webhook signing secret |
| **Sandbox** (`sandbox.ts`) | A local stand-in, clearly labeled, for trying the whole flow. Its checkout is `/pay/<token>` on this server; “paying” there moves no money | Nothing |

Demonstration organizations can only connect the sandbox. One connection is
active at a time (`Settings → Integrations → Card payments`). Secrets are
encrypted at rest (`BOOKS_ENCRYPTION_KEY`) and only ever shown masked.

### Setting up Stripe

1. In Stripe, create a restricted key with write access to Checkout Sessions
   and read access to Payment Intents and Balance Transactions (or use the
   secret key).
2. Connect Stripe in Gideon Books with the key, then add a webhook endpoint in
   Stripe at the address shown (`<APP_URL>/api/webhooks/payments/<connection id>`)
   for `checkout.session.completed`, `payment_intent.succeeded`,
   `charge.refunded` and `payout.paid`, and paste its signing secret.
3. Choose the bank account payouts arrive in.

`STRIPE_API_BASE` overrides the API address (tests use a stub).

## Webhooks

`POST /api/webhooks/payments/<connection id>`:

1. The signature is verified against the raw body before anything else
   (`t=<unix>,v1=<HMAC-SHA256 of "<t>.<body>">`, Stripe's scheme; the sandbox
   uses the same scheme in the `Gideon-Sandbox-Signature` header). A
   signature older or newer than five minutes is refused, so a captured
   request cannot be replayed later.
2. The event is recorded in `webhook_events`; the unique (provider, event id)
   refuses a replay inside the window (the provider's own retries are
   acknowledged and not processed again).
3. A job `payments.process_event` does the accounting; the route also tries
   it at once. Processing is idempotent and can be retried from the jobs page.

## Accounting

| event | entry |
|---|---|
| payment succeeded (`checkout.session.completed`, `payment_intent.succeeded`) | A customer payment of the **gross** amount into the connection's clearing account (*Payment processor clearing* by default), applied to the invoice; the processor's **fee** (from the payment's balance transaction) recorded on it as an expense, so clearing holds gross − fee |
| refund (`charge.refunded`) | A refund to the customer out of clearing, applied to the original payment. If the payment was applied to the invoice, that application is reduced first, so the **invoice reopens** by the refunded amount; issue a credit note if the sale itself is undone |
| payout (`payout.paid`) | A transfer from clearing to the payout bank account |

Idempotency: payments by `(provider, provider reference)` (unique), the fee
and payout entries by idempotency keys, events by their recorded status. The
clearing account therefore reconciles to the provider's balance, and its
payouts match the bank deposits in bank reconciliation.

Unverified without credentials: live calls to Stripe (checkout creation and
the balance-transaction lookup) are implemented against Stripe's documented
API and tested against a stub, not against a live Stripe account.
