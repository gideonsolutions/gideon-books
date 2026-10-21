# Bank feeds

Feeds bring bank transactions in without downloading files. They are
optional: CSV import does the same job by hand. A sync only adds bank
transactions for review; it never posts. Code: `lib/banking/feeds/`.

## Providers

| provider | mode | what it needs |
|---|---|---|
| **SimpleFIN Bridge** (`simplefin`) | live | a SimpleFIN setup token from a bridge the person signs up for |
| **Sandbox bank** (`sandbox`) | sandbox | nothing; generates labeled sample data |

The provider interface (`types.ts`) is two calls: `connect(setup)` turns what
the person pasted into a secret (stored encrypted with `BOOKS_ENCRYPTION_KEY`,
never shown again), and `fetch(secret, {start, end})` returns accounts with
transactions. Adding a provider (Plaid, a bank's own API) is a new adapter.

### SimpleFIN

[SimpleFIN](https://www.simplefin.org/protocol.html) is an open, read-only
protocol. The person obtains a **setup token** from a SimpleFIN Bridge (for
example `bridge.simplefin.org`, a paid service they sign up for themselves).

1. *Connect*: the token is base64 of a claim URL; Gideon Books `POST`s to it
   once and receives an **access URL** of the form
   `https://user:password@host/path`. A used or expired token answers 403.
2. *Sync*: `GET {access URL without credentials}/accounts?start-date=<unix>&end-date=<unix>`
   with HTTP basic authentication from the URL's user and password. Accounts
   (`id`, `name`, `currency`, `balance`, `balance-date`, `org`) and their
   transactions (`id`, `posted` epoch seconds, `amount` decimal string,
   `description`, `payee`, `memo`) are mapped; pending transactions (`posted`
   0 or `pending`) are skipped until they post.

The first sync of a linked account reaches back 90 days; later syncs overlap the
last 10 days. New transactions are those whose provider id the account has not
seen; each sync is an import batch whose rows keep the provider's records
verbatim.

**Unverified without credentials:** no live SimpleFIN account was available
while building this. The adapter follows the published protocol and is tested
against responses of that documented shape (`tests/banking/feeds.test.ts`), but
a real bridge's behaviour — rate limits, its exact error bodies, custom
currencies given as URLs — has not been exercised.

### Sandbox

Deterministic sample data for two accounts ("Sandbox Checking", "Sandbox
Card"): deposits, rent, supplies, coffee, fuel, a monthly fee. It never makes a
network request. Demonstration organizations can connect only the sandbox.

## Setting up

Settings → Integrations → Bank feeds (permission `integrations.manage`):
connect, then pick the money account each feed account feeds (one feed account
per money account; a feed reporting a currency must match the account's),
then *Sync now*. Errors from the provider are recorded on the connection and
shown there and on Banking. *Disconnect* destroys the stored access; what was
imported stays.

## Hosted metering

When `HOSTED_MODE=true`, each sync counts one `bank_feed_syncs` against the
plan (`lib/hosted/metering.ts`); a sync over the limit is refused with the
reason. Self-hosted installations are not metered.
