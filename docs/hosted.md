# The hosted offering

Gideon Books is open-source (Apache-2.0) and complete without any hosted
service. The hosted offering ("Gideon Books Pro") is the same software run by
Gideon Solutions, with plans, usage limits on the services that cost money,
and billing. All of it is switched off unless `HOSTED_MODE=true`.

## What the core never depends on

Reading the books, every report, posting, closing, and the complete data
export work whatever the subscription state. If a hosted subscription lapses,
only cost-bearing services stop: bank-feed syncs, email delivery, and new
uploads. Existing records stay available and exportable.

## Plans

Plans are configuration, not code: `HOSTED_PLANS` holds a JSON array, and the
default is one plan:

```json
[{ "key": "pro", "name": "Gideon Books Pro (hosted)", "monthlyPriceCents": 1000,
   "limits": { "bank_feed_syncs": 300, "documents_processed": 500, "storage_bytes": 5368709120, "emails_sent": 1000 } }]
```

The **$10/month price is tentative**; the billing page labels it so, and the
amount actually charged is whatever the Stripe price (`STRIPE_BILLING_PRICE_ID`)
says at checkout. A `null` limit is unlimited.

## Usage metering

`lib/hosted/metering.ts` records usage events and checks limits for:

| metric | counted when | period |
|---|---|---|
| `bank_feed_syncs` | each bank-feed sync | calendar month (UTC) |
| `documents_processed` | each attachment uploaded or generated | calendar month |
| `storage_bytes` | bytes of each attachment stored | cumulative |
| `emails_sent` | each email actually delivered (not the outbox) | calendar month |

Self-hosted (`HOSTED_MODE` unset), `recordUsage` and `assertWithinLimit` do
nothing. Limits by subscription state: no subscription yet / trialing /
incomplete → the plan's limits; active / past_due (grace) → the plan's
limits; canceled → zero.

## Billing (Stripe Billing)

Set `STRIPE_BILLING_SECRET_KEY`, `STRIPE_BILLING_PRICE_ID` and
`STRIPE_BILLING_WEBHOOK_SECRET`, and point a Stripe webhook at
`https://<APP_URL>/api/webhooks/billing` for `checkout.session.completed`,
`customer.subscription.created|updated|deleted`, `invoice.paid` and
`invoice.payment_failed`. The owner subscribes from Settings → Plan & usage
(Stripe-hosted checkout) and manages the card or cancels in Stripe's customer
portal.

Webhooks are verified (HMAC-SHA256 of `t.body`, five-minute timestamp
tolerance) before anything is stored; each event id is processed once
(replays are acknowledged and ignored); a failed event is forgotten so
Stripe's retry processes it again.

This is the platform charging for the hosted service. It is unrelated to the
payment providers an organization connects to collect from its own customers.

## Not verified here

The Stripe Billing calls are implemented against Stripe's documented API but
have not been exercised against a live Stripe account from this repository;
the webhook handling is covered by tests with signed synthetic events.
