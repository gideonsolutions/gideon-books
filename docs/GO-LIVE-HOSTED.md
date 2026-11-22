# Go live: Gideon Books Pro (hosted)

The owner's ordered checklist for opening the hosted offering. **It is a
plan for later.** Nothing here has been done yet. The reasoning, prices and
sources are in [hosting-gideon.md](hosting-gideon.md). This page is only the
order of work.

Every step is an account, secret or deploy action the owner takes himself.
Commands are shown for reference.

## 0. Before any of it: the code that must land first

**Do not take money until all of these are merged** (rows 1–7 of the
[readiness review](hosting-gideon.md#gaps-ranked)):

- [ ] 1. Email verification. Outbound customer mail only for verified, paying
      organizations, with a small trial cap. Limits on sign-ups and on
      organizations per account.
- [ ] 2. The trial ends (`trial_ends_at` set and enforced).
- [ ] 3. Checkout tags `metadata.site=books` on the session and the
      subscription. The billing webhook ignores anything not tagged `books`.
- [ ] 4. Billing code on a pinned Stripe API version, reading
      `invoice.parent.subscription_details` and the subscription items'
      periods.
- [ ] 5. Deleting an organization cancels its Stripe subscription.
- [ ] 6. A Books-only customer portal configuration, passed on every portal
      session.
- [ ] 7. Terms, privacy and pricing pages, with acceptance recorded at
      sign-up.
- [ ] Also needed for this checklist:
  - a `fly.toml`;
  - `npm run stripe:setup`;
  - the nightly backup uploader;
  - `clientIp()` reading `Fly-Client-IP`.

  All are specified in [hosting-gideon.md § 10](hosting-gideon.md#10-follow-ups-this-plan-depends-on-not-in-this-change).
- [ ] Strongly advised before the first customer: two-step sign-in required
      for owners, with recovery codes (gap 8).

## 1. Decide

- [ ] **The price.** It can only ever fall, so choose a number that will
      never need raising. The recommendation is $10 a month or $100 a year,
      with a 30-day trial ([pricing](hosting-gideon.md#9-pricing)). Put it in
      `HOSTED_PLANS` and in the Stripe setup script's configuration.
- [ ] **Plan limits**, including a `storage_bytes` the worker can actually
      export (gap 10).
- [ ] **Sales tax:** Stripe Tax or not.
- [ ] **The domain.** Confirm `gideonbooks.com` is in the Gideon Solutions
      GoDaddy account. It currently shows a "Launching Soon" page.

## 2. Create the hosting app, database and storage

- [ ] Create the app: `fly apps create gideon-books`, in the Gideon
      Solutions Fly organization.
- [ ] Create the database cluster:
      `fly mpg create --name gideon-books-db --region iad --plan basic --volume-size 10`.
      Choose **PostgreSQL 16**, or build the image with `PG_MAJOR` set to
      the version you choose.
- [ ] Attach it: `fly mpg attach <cluster-id> -a gideon-books`. This sets
      `DATABASE_URL`, the pooled endpoint. **Leave the pooler in session
      mode.**
- [ ] Copy the **direct** URL from the cluster's Connect tab. It becomes
      `DIRECT_DATABASE_URL` below.
- [ ] Create the attachment bucket: `fly storage create -a gideon-books`.
      **Save the printed key now; it is shown once.** Then turn on snapshots
      for the bucket in the Tigris console.
- [ ] Create a second bucket, `gideon-books-backups`, for nightly dumps, also
      with snapshots on.

## 3. Secrets and settings

Generate secrets on your own machine and set them with
`fly secrets set NAME=value -a gideon-books`. Plain settings go in
`fly.toml`'s `[env]`.

| Name | Kind | Value, or how to get it |
|---|---|---|
| `DATABASE_URL` | secret | set by `fly mpg attach` (pooled, session mode) |
| `DIRECT_DATABASE_URL` | secret | the cluster's direct URL (Connect tab); used by the release command and backups |
| `BOOKS_ENCRYPTION_KEY` | secret | `openssl rand -base64 48`. **Also store it offline in the password manager, never in the backup bucket.** Losing it means every provider secret must be re-entered and every two-step sign-in set up again. |
| `APP_URL` | env | `https://app.gideonbooks.com` |
| `SIGNUP_MODE` | env | `invite_only` until step 10 |
| `STORAGE_DRIVER` | env | `s3` |
| `S3_ENDPOINT` | env | the `AWS_ENDPOINT_URL_S3` value `fly storage create` printed |
| `S3_REGION` | env | `auto` |
| `S3_BUCKET` | env | the bucket name |
| `S3_ACCESS_KEY_ID` | secret | from `fly storage create` |
| `S3_SECRET_ACCESS_KEY` | secret | from `fly storage create` |
| `EMAIL_PROVIDER` | env | `resend` |
| `EMAIL_FROM` | env | `Gideon Books <noreply@mail.gideonsolutions.us>`, or the Books subdomain from step 5 |
| `RESEND_API_KEY` | secret | Resend → API keys → **sending access**, restricted to the Books domain |
| `FX_PROVIDER` | env | `ecb` |
| `DATABASE_POOL_MAX` | env | `5` |
| `WORKER_CONCURRENCY` | env | `2` |
| `LOG_LEVEL` | env | `info` |
| `TRUST_PROXY` | env | `true` |
| `HOSTED_PLANS` | env | the JSON from step 1 (price and limits) |
| `STRIPE_BILLING_SECRET_KEY` | secret | a **restricted** Stripe key with write access to Checkout Sessions, the customer portal and Subscriptions. **Test-mode key first; live only in step 9.** |
| `STRIPE_BILLING_PRICE_ID` | secret | printed by `npm run stripe:setup` (step 6) |
| `STRIPE_BILLING_WEBHOOK_SECRET` | secret | the `whsec_…` of the webhook endpoint (step 6) |
| `HOSTED_MODE` | env | **unset** in production until step 9 |

## 4. Point the domain

- [ ] Run `fly certs add app.gideonbooks.com -a gideon-books`.
- [ ] At GoDaddy, add a CNAME from `app` to the app's `.fly.dev` name, as
      `fly certs add` shows.
- [ ] Wait for `fly certs check app.gideonbooks.com` to show the certificate
      issued.

## 5. Resend

- [ ] Add the Books sending domain in Resend, for example
      `books.mail.gideonsolutions.us`. Until then, use the already verified
      `mail.gideonsolutions.us` for account mail only.
- [ ] Add the DNS records Resend shows at GoDaddy, and wait for Resend to
      verify them.
- [ ] Create the sending-only API key and set `RESEND_API_KEY`.

## 6. Stripe, in test mode

All in a Stripe **sandbox** (test mode) of the shared Gideon Solutions
account.

- [ ] Create the product and prices:
      `STRIPE_BILLING_SECRET_KEY=<test key> npm run stripe:setup`.
      It creates the product, the price(s) and the Books portal
      configuration, all tagged `site=books`. Set `STRIPE_BILLING_PRICE_ID`
      to the price it prints.
- [ ] Add a webhook endpoint at
      `https://app.gideonbooks.com/api/webhooks/billing`, on the **same API
      version the code pins**, for exactly these events
      ([hosted.md](hosted.md#billing-stripe-billing)):
  - `checkout.session.completed`
  - `customer.subscription.created`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `invoice.paid`
  - `invoice.payment_failed`

  Set `STRIPE_BILLING_WEBHOOK_SECRET` to its signing secret.
- [ ] Billing settings: choose the retry schedule for failed payments and
      what happens after the last retry. Cancelling sends
      `customer.subscription.deleted`, and Books then stops only the
      cost-bearing services.

## 7. First deploy and migrations

- [ ] Run `fly deploy` from the repository root. The release command runs
      the migrations over `DIRECT_DATABASE_URL`; a failure stops the deploy.
- [ ] Check `https://app.gideonbooks.com/api/health/ready`. Every check
      should pass: database, migrations, jobs and storage. The storage check
      writing to Tigris is the first live test of the S3 driver.
- [ ] **Before sharing the address**, create the first account, which
      becomes the instance administrator:
      `fly ssh console -a gideon-books -C "npx tsx scripts/create-user.ts --email <owner> --name <name> --admin"`.
- [ ] As self-hosted (`HOSTED_MODE` still unset), check each of these works:
  - sign in;
  - turn on two-step;
  - create an organization;
  - upload an attachment and download it (Tigris);
  - send yourself an invoice email (Resend);
  - export the organization.

## 8. Rehearse a subscription in Stripe test mode

Do this on a **rehearsal app** (`gideon-books-staging`) so production keeps
`HOSTED_MODE` off until step 9. It has the same image, a Developer database
(about $4 a month) or a database in the existing cluster, its own bucket,
test-mode Stripe keys and `HOSTED_MODE=true`.

- [ ] Sign up a fresh test account and create an organization. The trial
      shows, and its end date is correct.
- [ ] Subscribe with Stripe's test card `4242 4242 4242 4242`. The webhook
      arrives, and the plan shows **active** with the right period end.
- [ ] Open the customer portal. It shows **only** Books, with cancel,
      payment method and invoice history.
- [ ] Fail a renewal with a test card that declines. The organization shows
      **past due**.
- [ ] Cancel in the portal. The organization shows **canceled**:
  - feeds, email and uploads stop;
  - books, reports and export still work.
- [ ] Delete a subscribed test organization. Its Stripe subscription is
      canceled.
- [ ] In Gideon Tax's revenue report, the test charges show as another
      site's (tagged `books`), **not** "Unattributed".
- [ ] Destroy the rehearsal app, database and bucket when done.

## 9. Restore drill, then turn on HOSTED_MODE with live keys

- [ ] **Restore drill on the production cluster before the first paying
      customer**, exactly as in
      [hosting-gideon.md](hosting-gideon.md#restore-drill-before-the-first-paying-customer-then-every-quarter):
      point-in-time restore, last night's dump, the attachment snapshot.
      Write down the result. Repeat it every quarter.
- [ ] Switch Stripe to live mode:
  - run `npm run stripe:setup` with the **live** restricted key and
    `BOOKS_LIVE_BILLING=1`;
  - add the live webhook endpoint for the same six events;
  - set the live `STRIPE_BILLING_*` secrets.
- [ ] **Turn on `HOSTED_MODE=true`** in production, still with
      `SIGNUP_MODE=invite_only`.
- [ ] Subscribe your own organization at the real price with a real card,
      then cancel and refund it in Stripe. This is the first live
      end-to-end charge.
- [ ] Schedule the nightly dump Machine and an outside uptime monitor on
      `/api/health/ready`.

## 10. Open the doors

- [ ] Publish the terms, privacy and pricing pages. The pricing page shows
      the free self-hosted option as prominently as Pro.
- [ ] Set `SIGNUP_MODE=open`.
- [ ] Change Books' card on the Gideon Solutions site from "In development"
      to live, linking to `gideonbooks.com`.
- [ ] Update `docs/limitations.md` for every service now verified live, in
      the same change that says so.
