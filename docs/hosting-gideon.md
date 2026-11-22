# How Gideon Solutions would run Gideon Books Pro

**Status: a plan, not a launch.** Nothing described here has been created:
no hosting app, database, bucket, Stripe product or domain record exists for
Books yet. This is how Gideon Solutions, LLC intends to run the hosted
offering ([hosted.md](hosted.md)) when it decides to, what the code still
lacks before strangers' books can be trusted to it, and what to charge. The
ordered steps are in [GO-LIVE-HOSTED.md](GO-LIVE-HOSTED.md).

Self-hosting is unaffected: everything here is about one operator's
deployment. The free, self-hosted path ([self-hosting.md](self-hosting.md))
stays the first thing people see.

Prices, limits and provider behaviour below were read from each provider's
own pages on **2026-11-22** and are **approximate**: they change, and some
depend on usage. Every figure has its source in [Sources](#sources).

---

## The recommendation in one table

| Part | Choice | Approx. monthly cost |
|---|---|---|
| Where it runs | **Fly.io**: one app, the existing Docker image, two process groups (`app`, `worker`) in `iad` | $13.40 (two 1 GB shared-CPU Machines) |
| Database | **Fly Managed Postgres, Basic plan**, its own cluster, PostgreSQL 16 | $40.80 ($38 plan + 10 GB at $0.28) |
| Attachments | **Tigris** (Fly's S3-compatible storage), private bucket with snapshots on | under $1 at launch (first 5 GB free) |
| Email | **Resend** from `noreply@mail.gideonsolutions.us`; a separate Books sending subdomain before open sign-up | $0 if the existing Resend plan has room; Pro is $20 |
| Domain | **`app.gideonbooks.com`** (the apex is already registered, see [Domain](#5-domain)) | $0 (already registered) |
| TLS | Fly's automatic certificates | $0 (first 10 per organization free) |
| Health | Fly routing check on `/api/health`; readiness `/api/health/ready` as a non-routing check plus an outside monitor | $0 |
| **Total before the first customer** | | **about $56** (about $76 if a new Resend Pro plan is needed) |

Each charge also costs Stripe fees: Stripe Billing's 0.7% plus card
processing at 2.9% + 30¢. That comes to about **66¢ on a $10 charge (6.6%)**
and about **$3.90 on a $100 charge (3.9%)**.

---

## 1. Where it runs: Fly.io, two process groups

**Recommendation: Fly.io**, running the image `Dockerfile` already builds,
as one Fly app with two [process groups][fly-config]:

- **`app`**: `npx next start --port 3200`, the web application and API.
- **`worker`**: `npx tsx scripts/worker.ts`, the background jobs.

Migrations run as the deploy's `release_command`.

Why not the app on Vercel with the worker somewhere else:

- **The worker is a long-lived loop.** It polls the job queue every second
  (`WORKER_IDLE_MS`, `scripts/worker.ts`) and runs the daily schedule. Vercel
  Functions run per request, for at most 300 s by default and 800 s on Pro
  ([Vercel limits][vercel-limits]). The worker would need a second host, so
  Vercel means two providers, two deploys and two bills.
- **Uploads and downloads are larger than Vercel's default limits.** Books
  accepts attachments up to 20 MB (`ATTACHMENT_MAX_BYTES`) and server-action
  bodies up to 25 MB (`next.config.ts`). Vercel Functions accept request
  bodies up to **4.5 MB** by default; 20 MiB is a public beta that requires
  4 GB function memory. Response bodies are also limited to **4.5 MB** unless
  streamed ([Vercel limits][vercel-limits]).
- **It already runs as a container.** The image, its health check and the
  Compose stack were built and run locally. Fly runs the same image without
  changes.
- **The database sits on the same private network.** Fly Managed Postgres is
  reached inside the Fly organization, not over the public internet.
- **The owner already runs several Fly apps** in `iad` and one Managed
  Postgres cluster, so the tools, billing and deploy habits already exist.
  `iad` is also among the lowest-priced regions on Fly's pricing page.

What Fly does not give: Vercel-style preview deployments, and automatic
deploys. The owner deploys by hand with `fly deploy`.

### What the `fly.toml` must say (a follow-up; not in this change)

| Setting | Value | Why |
|---|---|---|
| `app`, `primary_region` | `gideon-books`, `iad` | where the other Gideon Fly apps run |
| `[processes]` | `app = "npx next start --port 3200"`, `worker = "npx tsx scripts/worker.ts"` | the same commands as `docker-compose.yml` |
| `[deploy] release_command` | `sh -c 'DATABASE_URL="$DIRECT_DATABASE_URL" exec npx tsx scripts/migrate.ts'`, `release_command_timeout = "10m"` | Fly runs it once per deploy in a temporary Machine that has the app's secrets but no volumes; a non-zero exit stops the deploy ([Fly config][fly-config]). Migrations go over the **direct** connection ([Fly MPG client configuration][fly-mpg-client]). |
| `[http_service]` | `processes = ["app"]`, `internal_port = 3200`, `force_https = true`, `auto_stop_machines = "off"`, `min_machines_running = 1` | always on; the worker has no service |
| `[[http_service.checks]]` | `GET /api/health`, every 30 s, 5 s timeout, 30 s grace | **liveness only**: see [Health checks](#6-tls-and-health-checks) |
| `[checks.ready]` | `type = "http"`, `port = 3200`, `path = "/api/health/ready"`, every 60 s, `processes = ["app"]` | top-level checks "don't affect request routing" ([Fly config][fly-config]) |
| `[[vm]]` | `shared-cpu-1x`, `memory = "1gb"`, for both groups | `self-hosting.md` asks for about 1 GB for app and worker together; the worker builds export ZIPs in memory (see [Readiness](#8-readiness-review-hosting-other-businesses-books)) |
| `kill_signal`, `kill_timeout` | `SIGTERM`, at least the worker's drain time | the worker stops claiming jobs on SIGTERM and lets running jobs finish |
| `[[mounts]]` | none | attachments go to Tigris, so Machines hold no state |
| build arg | `PG_MAJOR` = the cluster's PostgreSQL major version | `pg_dump` must match the server |

---

## 2. Database: Fly Managed Postgres, its own Basic cluster

**Recommendation: a new Fly Managed Postgres cluster on the Basic plan,**
PostgreSQL 16, in `iad`, used only by Books.

The Basic plan is a shared-2x CPU with 1 GB of memory, at **$38 a month**,
plus storage at **$0.28 per GB-month** ([Fly MPG][fly-mpg]). Per Fly, every
plan runs a primary and a replica with automatic failover, keeps backups for
**ten days**, and offers point-in-time restore. `fly mpg restore` builds a
**new** cluster from a backup or a point in time and leaves the source
untouched ([Fly MPG product page][fly-mpg-product],
[fly mpg restore][fly-mpg-restore]). The $4 Developer plan takes one full
backup a day and has no point-in-time restore. That is fine for a rehearsal
app, not for customers' books.

**Why a cluster of its own,** rather than a database inside the existing
cluster (`fly mpg databases create`):

- Restores are per cluster. Recovering Books to 10:02 should not also roll
  back another product.
- Customers' financial records are kept apart from everything else Gideon
  Solutions runs.
- It can be sized and upgraded on its own. A cluster cannot be upgraded to a
  new PostgreSQL version in place ([Fly MPG][fly-mpg]).

A database inside the existing cluster would cost little more than its
storage, and is acceptable for a private beta with no paying customers.

**Why not Neon.** Neon's Launch plan is cheaper on paper: $0.106 per
compute-unit hour and $0.35 per GB-month, with no minimum
([Neon pricing][neon]). However, the worker queries the database every
second, so the compute never scales to zero. At 0.25 CU running all month
(an example size), that is 0.25 × 730 × $0.106 ≈ **$19**, plus about $3.50
for 10 GB, so about **$23** against Fly's $40.80. The difference buys:

- one vendor instead of two;
- a private network instead of traffic over the internet;
- a ten-day backup window instead of Launch's "up to 7 days" of history.

For a single owner holding other people's books, that is worth about $18 a
month. If cost matters more later, Neon is a supported PostgreSQL and the
same `DATABASE_URL` works.

**Connections:**

- `fly mpg attach` sets `DATABASE_URL` to the **pooled** (PgBouncer)
  endpoint. MPG's pooler defaults to **session mode**, where advisory locks
  work ([Fly MPG client configuration][fly-mpg-client]). **Keep it in session
  mode:** Books takes a session-level advisory lock across several statements
  in `lib/purchases/recurring.ts`, which transaction mode breaks.
- Also store the **direct** URL (from the cluster's Connect tab) as
  `DIRECT_DATABASE_URL`, for migrations and `pg_dump`.
- Keep `DATABASE_POOL_MAX` small (5). Each process holds its own pool.

### Backup schedule

| Layer | What | When | Kept |
|---|---|---|---|
| 1. Provider | MPG automatic backups with point-in-time restore | continuous (Fly's schedule) | 10 days |
| 2. Off-cluster dump | `scripts/backup.sh` against `DIRECT_DATABASE_URL`, uploaded to a **separate** Tigris bucket (`gideon-books-backups`, snapshots on) | nightly, from a scheduled Machine (`fly machine run … --schedule daily`, [fly machine run][fly-machine-run]) | 30 dailies + 12 monthlies |
| 3. Attachments | Tigris snapshots of the attachment bucket; recover by forking a snapshot ([Tigris snapshots][tigris-snapshots]) | weekly snapshot | at least 12 weeks |
| 4. Each organization | Settings → Data export ([backup-restore.md](backup-restore.md)) | whenever the customer wants | the customer's copy |

Gaps in layer 2, which are follow-ups:

- The image has no S3 uploader. `backup.sh` writes to a local directory, so
  a small script reusing `lib/storage/storage.ts` is needed to send the dump
  to the backup bucket.
- `backup.sh` does not copy attachments when `STORAGE_DRIVER=s3`.

**`BOOKS_ENCRYPTION_KEY`** lives in two places only: the Fly secret, and an
offline copy in the owner's password manager. It is **never** in the backup
bucket. A backup plus its key exposes every stored provider secret.

### Restore drill (before the first paying customer, then every quarter)

`scripts/verify-restore.sh` creates a scratch database on the same server.
It is not known whether the MPG user may `CREATE DATABASE`, so the drill on
Fly uses MPG's own restore:

1. Record a time T, and the trial balance of a test organization at T.
2. Run `fly mpg restore <cluster-id> --pitr-time <T> --name books-drill`, or
   `--backup-id` with an ID from `fly mpg backup list`. Fly creates a new
   cluster and bills it separately ([fly mpg restore][fly-mpg-restore]).
3. Start a one-off Machine from the current image with `DATABASE_URL` set to
   the drill cluster. `/api/health/ready` must pass, and the test
   organization's trial balance must equal the figure from step 1.
4. Restore last night's off-cluster dump with `scripts/restore.sh` into an
   empty database on the drill cluster. The script refuses a non-empty
   target, checks every file against the manifest, and checks that every
   organization's ledger balances.
5. Fork the attachment bucket's latest Tigris snapshot. Point the one-off
   Machine's `S3_BUCKET` at the fork and download one attachment.
6. Destroy the drill cluster (`fly mpg destroy`) and the fork. Write down the
   date, how long it took and the result.

---

## 3. File storage: Tigris

**Recommendation: a private Tigris bucket** created with
`fly storage create`. Tigris usage appears on the Fly bill
([Fly Tigris docs][fly-tigris]).

**Prices** ([Tigris pricing][tigris-pricing]):

- Standard storage: **$0.02 per GB-month**.
- Class A requests (writes): **$0.005 per 1,000**.
- Class B requests (reads): **$0.0005 per 1,000**.
- Egress: **free**.
- The first 5 GB, 10,000 Class A and 100,000 Class B requests each month are
  free.

At the default plan limit of 5 GB per organization, a full organization
costs at most about 10¢ a month to store.

**Configuration:** `fly storage create` sets `BUCKET_NAME`,
`AWS_ENDPOINT_URL_S3`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and
`AWS_REGION=auto`, and shows the key only once ([Fly Tigris docs][fly-tigris],
[Fly JS object storage][fly-js-storage]). Books reads different names, so
copy the values into:

- `STORAGE_DRIVER=s3`
- `S3_ENDPOINT` (the `AWS_ENDPOINT_URL_S3` value)
- `S3_REGION=auto`
- `S3_BUCKET`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`

**Unverified:** Books' S3 driver signs **path-style** requests
(`endpoint/bucket/key`) and has never run against a live bucket
([limitations.md](limitations.md)). The Tigris pages read for this plan do
not say whether path-style addressing is supported. Rehearse first; the
readiness check writes a test object, so a refusal shows at once.

**Snapshots:** turn snapshots on for the bucket in the Tigris console. Object
versioning is only available on snapshot-enabled buckets, and object
expiration is not supported on them ([Tigris snapshots][tigris-snapshots],
[Tigris S3 API][tigris-s3]).

---

## 4. Email: Resend

- `EMAIL_PROVIDER=resend`
- `RESEND_API_KEY`: a sending-only key, limited to the Books sending domain.
- `EMAIL_FROM="Gideon Books <noreply@mail.gideonsolutions.us>"`.

Resend's Free plan allows 3,000 emails a month (100 a day) and 3 domains.
Pro is **$20 a month** for 50,000 emails and 10 domains
([Resend pricing][resend]). If Gideon Solutions' account already has room,
Books adds nothing until volume grows.

**Before sign-up opens to strangers, give Books its own sending subdomain,**
for example `books.mail.gideonsolutions.us` or `mail.gideonbooks.com`. Books
sends mail that **customers write**, such as invoices, statements and
invitations, to **any address**, so abuse of Books must not damage the
reputation of the domain that Gideon Tax's mail relies on.

- Password resets can keep `noreply@mail.gideonsolutions.us`.
- Invoices already set Reply-To to the organization's own address
  (`lib/sales/documents.ts`).

---

## 5. Domain

**`gideonbooks.com` resolves.** RDAP shows it registered at GoDaddy on
2025-12-28, expiring 2027-12-28. Its DNS is on GoDaddy's `domaincontrol.com`
nameservers, the same as `gideonsolutions.us`. Today it serves a GoDaddy
Website Builder **"Launching Soon"** page. The registrant is redacted, so
**confirm it is in the Gideon Solutions GoDaddy account** before relying on
it. `books.gideonsolutions.us` does not resolve.

Recommendation:

- Run the app at **`app.gideonbooks.com`** (`APP_URL`).
- Keep the apex `gideonbooks.com` for a public page with pricing and the
  free self-hosted option (the app's own `/` only redirects to sign-in).
- The subdomain needs one CNAME to the app's `.fly.dev` name and
  `fly certs add app.gideonbooks.com` ([Fly custom domains][fly-domains]).
- If the domain is not the company's, use `books.gideonsolutions.us`
  instead.

---

## 6. TLS and health checks

**TLS:** Fly terminates TLS with automatic Let's Encrypt certificates
([Fly custom domains][fly-domains]). The first 10 single-hostname
certificates per organization are free, then $0.10 a month each
([Fly pricing][fly-pricing]). An `https://` `APP_URL` turns on secure cookies
and HSTS (`next.config.ts`, `lib/web/session.ts`). The shared IPv4 address is
free; a dedicated one is $2 a month and is not needed.

**Client addresses:** Books takes the **first** `X-Forwarded-For` entry as
the client's address (`clientIp()` in `lib/web/session.ts`). Fly warns that
header "must be treated with caution to avoid spoofing attempts", and puts
the address its proxy saw in `Fly-Client-IP` ([Fly request headers][fly-headers]).

Until Books reads `Fly-Client-IP` (a follow-up), anyone can forge the header
to get around the **per-address** sign-in throttle. The **per-account**
throttle still holds.

**Health checks:**

- **Routing:** `GET /api/health` (liveness), so the web app only leaves
  rotation when it stops answering.
- **`/api/health/ready` must not decide routing.** It fails when due jobs
  wait more than 15 minutes, which happens whenever the **worker** is down. As
  a routing check, a stopped worker would take the web app offline too.
  Run it as a top-level `[checks]` entry, which does not route, and from an
  outside uptime monitor that alerts after a few minutes.
- Each readiness call writes and deletes a probe object in storage: one
  Class A request a minute is about 43,000 a month, roughly 17¢ after the
  free 10,000.
- Alert as in [operations.md](operations.md): readiness failing, any
  `"level":"error"` line, dead jobs, a failed restore drill.

---

## 7. Approximate monthly cost

| Component | Size | Approx. $/month | Source |
|---|---|---|---|
| `app` Machine | shared-cpu-1x, 1 GB, always on | 6.70 | [Fly pricing][fly-pricing] |
| `worker` Machine | shared-cpu-1x, 1 GB, always on | 6.70 | [Fly pricing][fly-pricing] |
| Release-command Machine | seconds per deploy | ~0 | [Fly pricing][fly-pricing] (per-second billing) |
| Managed Postgres | Basic plan + 10 GB | 38.00 + 2.80 | [Fly MPG][fly-mpg] |
| Tigris (attachments + backups) | under 5 GB at launch, readiness probes | under 1 | [Tigris pricing][tigris-pricing] |
| Outbound transfer | a few GB at $0.02/GB | under 1 | [Fly pricing][fly-pricing] |
| TLS certificate, shared IPv4, IPv6 | | 0 | [Fly pricing][fly-pricing] |
| Resend | existing plan, or Pro | 0, or 20 | [Resend pricing][resend] |
| Domain | already registered to 2027-12-28 | 0 | RDAP |
| **Total** | | **about 56** (about 76 with a new Resend Pro plan) | |
| *Optional:* a second `app` Machine for deploys without a gap | | +6.70 | [Fly pricing][fly-pricing] |
| *Optional:* a rehearsal app (Developer database, auto-stopped Machines) | | about 5 while it exists | [Fly MPG product page][fly-mpg-product] |

**Per charge (Stripe):** Billing 0.7% + card 2.9% + 30¢ ([Stripe Billing pricing][stripe-billing]).

**Break-even** at $10 a month: about **6 subscribers** ($56 ÷ $9.34 net).

---

## 8. Readiness review: hosting other businesses' books

Verified in the code on 2026-11-22. First, what is already sound, then the
gaps, worst first.

### Already in place

- **Anyone can sign up and create organizations**: `SIGNUP_MODE=open`, then
  `/orgs/new`.
- **Tenant isolation:**
  - Every page resolves the member's role on the server, and a non-member
    gets 404 (`orgCtx`, `lib/web/session.ts`).
  - Every service function scopes by `ctx.orgId`.
  - Every organization-owned table carries `org_id` and references other
    rows through composite `(org_id, id)` foreign keys. This is enforced in
    the database and checked by `tests/db/tenancy.test.ts`.
  - API tokens belong to one organization, and another organization's token
    is refused (`tests/api/api.test.ts`).
- **Passwords and sessions:**
  - Passwords are hashed with scrypt.
  - Sessions are stored as hashed tokens.
  - Sign-in and two-step codes are throttled: 8 failures in 15 minutes locks
    that account and that address for 15 minutes.
- **Two-step sign-in (TOTP)** exists: RFC 6238, any authenticator app, seed
  encrypted at rest (`lib/auth/totp.ts`, Account settings).
- **Data protection:**
  - Posted entries and the audit trail are append-only, enforced by database
    triggers.
  - Attachments are served only through an authorized route, as downloads.
  - Strict security headers and a content security policy are set.
- **Full data export:** a ZIP of every table and attachment with SHA-256
  checksums, documented ([data-export-format.md](data-export-format.md)),
  with a matching importer.
- **Organization deletion:** owner only. It needs an export or an explicit
  decline, removes everything in one transaction and is audited.
- **Backups:** `backup.sh`, `restore.sh` and `verify-restore.sh` exist, and
  CI proves a restore on every change.

### Gaps, ranked

| # | Gap | What the code does today | What is needed |
|---|---|---|---|
| 1 | **Outbound email abuse from a shared domain.** **Blocks open sign-up.** | Anyone can sign up: there is no email verification (`users.email_verified_at` exists but is never set or checked), no CAPTCHA and no sign-up throttle. They can create any number of organizations. With no subscription, each gets the plan's **1,000 emails a month**, with free-text subject, body and attachments, sent to any address from Gideon Solutions' verified domain. | Verify the address before any outbound mail. Allow outbound customer email only on an active subscription, or a tiny trial cap. Limit organizations per account and sign-ups per address. Use a separate sending subdomain ([Email](#4-email-resend)). |
| 2 | **Nobody ever has to pay.** **Blocks charging.** | "No row means the organization is on its trial" (`lib/db/schema/hosted.ts`); no subscription gets the full plan limits forever. `trial_ends_at` exists but is never set or read. | Set `trial_ends_at` when a hosted organization is created. After it passes with no subscription, apply the lapsed limits, which only stop cost-bearing services. Books, reports and export stay available. |
| 3 | **The billing webhook is not safe on a shared Stripe account.** **Blocks charging.** | A Stripe webhook endpoint receives every event on the account, including other Gideon products'. `handleBillingWebhook` takes `client_reference_id` or `metadata.orgId` from any event and inserts it into a `uuid` column. Another product's non-UUID value makes the insert throw, so the endpoint answers **500** to events that are not Books' at all. Checkout also sets **no `site` tag**, so other products' revenue reports count Books money as "Unattributed". | Send `metadata[site]=books` and `subscription_data[metadata][site]=books` on checkout. Acknowledge and ignore any event not tagged `books`, or whose organization is not a real Books organization. Gideon Tax already ignores events tagged with another site. |
| 4 | **Stripe's current API shape is not handled.** **Blocks charging.** | The handler reads `invoice.subscription` and `subscription.current_period_end`. In API version `2025-03-31.basil`, Stripe removed both: they are now `invoice.parent.subscription_details.subscription` and `items.data[].current_period_end` ([Stripe changelog: invoice parent][stripe-parent], [Stripe changelog: item periods][stripe-periods]). Gideon Tax's code already reads `invoice.parent.subscription_details`, which suggests the shared account is on the newer shape. If so, `invoice.payment_failed` and `invoice.paid` are **silently ignored**: a failed payment never marks the organization past due, and the period end is never stored. | Send a pinned `Stripe-Version` header, create the webhook endpoint on that same version, read the new fields, and test with fixtures in the new shape. |
| 5 | **Deleting an organization keeps charging the customer.** **Blocks charging.** | `deleteOrganization` cascades the `subscriptions` row away but never cancels the Stripe subscription. | In hosted mode, cancel the subscription through the API before the purge, and refuse the deletion if the cancel fails. |
| 6 | **The customer portal is shared.** **Blocks charging.** | `billing_portal/sessions` uses the account's default portal configuration, which other Gideon products share. If one of them allows plan switching, a Books customer could be offered another product's prices. | Create a Books-only portal configuration with cancel, payment method and invoice history, and pass `configuration=` when opening a session ([Stripe portal][stripe-portal]). |
| 7 | **No terms of service, privacy policy or pricing page.** **Blocks charging.** | There is no `/terms`, no `/privacy`, nothing to accept at sign-up, and `/` only redirects to sign-in. | The owner, with counsel, writes terms and a privacy policy covering subprocessors (Fly.io, Tigris, Resend, Stripe), retention after cancellation and non-payment, the security contact, and exactly what is encrypted (row 13). The code needs the pages, a sign-up checkbox that records the version and time accepted, and a public pricing page. |
| 8 | **Two-step sign-in is optional and incomplete.** **First security follow-up, required before holding others' financial records.** | TOTP exists but: no recovery codes; nobody can be required to use it (no organization policy, nothing for owners or accountants); a code can be reused within its 90-second window, because the last accepted step is not stored. | Hashed one-time recovery codes. Require two-step in hosted mode for owners and administrators at least, and let an organization require it of all members. Refuse a reused step. |
| 9 | **A person cannot delete their own account.** | Organizations can be deleted, but a user record (name, email, sessions) can only be disabled from the command line by the operator. | Self-service account deletion that refuses while the person is an organization's sole owner, plus an operator procedure for requests by email. |
| 10 | **The no-lock-in export only works for small organizations.** | The export is built **in memory** (`zipSync`, `lib/ops/export.ts`): every attachment plus the compressed copy, so roughly twice the organization's data at once in the worker. The web import goes through a server action limited to **25 MB**. The plan allows **5 GB** of storage per organization. | Stream the export to storage, and stream or command-line the import. Until then, lower `storage_bytes` in `HOSTED_PLANS` to a size the worker can export, measured in the rehearsal, or give the worker more memory. |
| 11 | **Rate limits stop at sign-in.** | Nothing limits sign-up, forgot-password (an email to an existing account on every request), invitations, organization creation, uploads or the REST API. The client address can be forged on Fly ([TLS and health checks](#6-tls-and-health-checks)). | Read `Fly-Client-IP`. Add per-address and per-account limits on those routes, and a per-token API limit. |
| 12 | **Isolation has no database backstop.** | Isolation is enforced by application code. There is no PostgreSQL row-level security, so one query that forgets `org_id` would leak across organizations, and no test sweeps every route as a member of another organization. | A cross-organization test sweep before launch; row-level security later. |
| 13 | **Encryption at rest is narrower than it may sound.** | `BOOKS_ENCRYPTION_KEY` (AES-256-GCM, `lib/crypto/secrets.ts`) encrypts only provider secrets, bank-feed access URLs and two-step seeds. Ledgers, contacts and attachments are stored as-is and rely on whatever the providers do at the disk level, which was not checked for this plan. Rotation via `BOOKS_ENCRYPTION_KEY_PREVIOUS` has no re-encryption command, so the old key must stay set indefinitely. | Say exactly this in the privacy policy, after confirming Fly's and Tigris's disk encryption on their own security pages. Add a re-encryption command. Keep the key as in [Backup schedule](#backup-schedule). |
| 14 | **Backups need hosted plumbing.** | `verify-restore.sh` needs `CREATE DATABASE` on the same server, which may not be granted on MPG. `backup.sh` skips S3 attachments and only writes locally. Fly has no cron, so nothing schedules a backup. | The drill in [Restore drill](#restore-drill-before-the-first-paying-customer-then-every-quarter), an uploader for the nightly dump, and a scheduled Machine. |
| 15 | **The services money depends on are unverified.** | Stripe Billing, Resend, the S3 driver against Tigris, the ECB fetch and SimpleFIN have never run against a live account ([limitations.md](limitations.md)). | The rehearsal and the live test in [GO-LIVE-HOSTED.md](GO-LIVE-HOSTED.md). |

Also: **the first account to sign up becomes the instance administrator.**
The flag grants nothing in the interface today. Still, the owner creates the
first account from the command line before the address is public.

---

## 9. Pricing

### What competitors charge

Regular list prices in USD a month, read from their own US pricing pages on
2026-11-22. All four were running limited-time promotions that day; those
are noted but are not the regular price.

| Product | Free option | Entry paid plan | Higher plans | Trial | Source |
|---|---|---|---|---|---|
| **QuickBooks Online** | a $0 "Free" plan, 1 user | **Simple Start $38** (1 user) | Essentials $85 (3 users), Plus $140 (5), Advanced $340 (25) | 30 days | [QuickBooks pricing][qbo]; "70% off for 3 months", ending 11/29 |
| **Xero (US)** | none | **Early $27** (20 invoices, 5 bills) | Growing $59, Established $97 | "Get one month free" button, terms not shown | [Xero pricing][xero]; 90% off for 6 months, ending November 30 |
| **Zoho Books (US)** | Free: revenue under $50K a year, 1 user + 1 accountant, 1,000 invoices a year | **Standard $15** billed yearly, **$20** monthly (3 users) | Professional $40/$50, Premium $60/$70, Elite $120/$150, Ultimate $240/$275 | 14 days | [Zoho Books pricing][zoho] |
| **Wave** | Starter $0, no automatic bank import | **Pro $19** monthly, or **$190** a year | | none stated | [Wave pricing][wave] |

Gideon Books' scope is closer to the mid tiers than the entry plans. It
includes inventory, fixed assets, multiple currencies, projects, budgets,
consolidation, nonprofit funds and an API. The hosted service costs
Gideon Solutions little per organization: bank-feed access is the customer's
own SimpleFIN account, and storage and email cost cents.

### Recommendation

**The owner decides the number.** He prefers prices that only ever fall, so
the launch price is the highest Books Pro will ever cost: choose a number he
will never need to raise. This is a recommendation, not a decision.

- **$10 a month, or $100 a year, per organization.**
  - The README and the billing page have already said "tentatively about $10
    a month". Launching higher would read as a rise before launch.
  - $10 is below every competitor's entry paid plan: Zoho $15–20, Wave $19,
    Xero $27, QuickBooks $38.
  - It covers the fixed cost at about 6 subscribers.
- **Offer yearly.** $100 a year is two months free, the same ratio as Wave's
  $190. One charge a year also costs much less in Stripe fees: about 3.9%,
  against 6.6% on monthly $10 charges.
- **A 30-day free trial, no card required.** This matches QuickBooks' trial
  length. It depends on gap 2 being fixed. During the trial, outbound email
  waits for a verified address and stays capped (gap 1).
- **No free hosted tier.** The free option is **self-hosting**, with the
  same software and every feature. Show it on the pricing page as
  prominently as the paid plan:

  > "Free forever on your own server — [self-hosting guide](self-hosting.md)."

- **Later, only downward:** a discount for accountants with many client
  organizations. Cutting a price or adding a discount keeps faith with
  "prices only fall". Raising one does not.

Sales tax on the subscription is a decision for the owner (Stripe Tax or
not) before taking the first live payment. This plan does not take a
position on which states tax it.

---

## 10. Follow-ups this plan depends on (not in this change)

1. **Code, before charging:** gaps 1–7 above, then 8 (two-step) as the first
   security change.
2. **`fly.toml`:** as specified in [What the fly.toml must say](#what-the-flytoml-must-say-a-follow-up-not-in-this-change).
3. **Stripe setup script (`npm run stripe:setup`),** in the style of Lumenary
   Prep's:
   - It refuses a live key (`sk_live_…`, `rk_live_…`) unless
     `BOOKS_LIVE_BILLING=1` is also set.
   - It is safe to run again. It finds the product by `metadata.site=books`
     and the prices by lookup key (`books_pro_monthly`, `books_pro_yearly`),
     and creates only what is missing.
   - The amounts are configuration (`BOOKS_PRO_MONTHLY_CENTS`,
     `BOOKS_PRO_YEARLY_CENTS`). An existing price's amount is never changed,
     because Stripe fixes a price's amount once created
     ([Stripe portal][stripe-portal]). A new amount is a new price, and the
     lookup key moves to it.
   - Every object carries `metadata.site=books`.
   - It creates the Books-only portal configuration (gap 6).
   - It prints `STRIPE_BILLING_PRICE_ID` and the webhook events to register.
   - It is tested against a stubbed Stripe, like the existing webhook tests.
4. **`.env.hosted.example`:** the table in
   [GO-LIVE-HOSTED.md](GO-LIVE-HOSTED.md#3-secrets-and-settings), as a file.
5. **Backups:** the dump uploader and the scheduled Machine (gap 14).

---

## Sources

Read on 2026-11-22. Figures are approximate and change.

- [fly-pricing]: Fly.io, *Pricing* — https://docs.fly.io/about/pricing
- [fly-mpg]: Fly.io, *Managed Postgres* (plans, storage, versions, high availability) — https://docs.fly.io/postgres
- [fly-mpg-product]: Fly.io, *Managed Postgres* product page (ten-day backups, point-in-time restore, Developer plan) — https://fly.io/mpg/
- [fly-mpg-restore]: Fly.io, *fly mpg restore* — https://docs.fly.io/flyctl/mpg-restore
- [fly-mpg-client]: Fly.io, *Connect your client* (pooled vs direct, session mode default, migrations over direct) — https://docs.fly.io/mpg/client-configuration
- [fly-config]: Fly.io, *App configuration (fly.toml)* — https://docs.fly.io/reference/configuration
- [fly-domains]: Fly.io, *Custom domains* — https://docs.fly.io/networking/custom-domain
- [fly-headers]: Fly.io, *Request headers* — https://docs.fly.io/networking/request-headers
- [fly-tigris]: Fly.io, *Tigris object storage* — https://docs.fly.io/tigris
- [fly-js-storage]: Fly.io, *Object storage for JavaScript* — https://docs.fly.io/js/the-basics/object-storage
- [fly-machine-run]: Fly.io, *fly machine run* (`--schedule`) — https://docs.fly.io/flyctl/machine-run
- [tigris-pricing]: Tigris, *Pricing* — https://www.tigrisdata.com/pricing/
- [tigris-snapshots]: Tigris, *Snapshots* — https://www.tigrisdata.com/docs/snapshots/
- [tigris-s3]: Tigris, *S3 API compatibility* — https://www.tigrisdata.com/docs/api/s3/
- [neon]: Neon, *Pricing* — https://neon.com/pricing
- [vercel-limits]: Vercel, *Vercel Functions limits* — https://vercel.com/docs/functions/limitations
- [resend]: Resend, *Pricing* — https://resend.com/pricing
- [stripe-billing]: Stripe, *Billing pricing* — https://stripe.com/billing/pricing
- [stripe-portal]: Stripe, *Integrate the customer portal with the API* — https://docs.stripe.com/customer-management/integrate-customer-portal
- [stripe-parent]: Stripe changelog, *Invoicing resources now specify how they were generated* (2025-03-31.basil) — https://docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects
- [stripe-periods]: Stripe changelog, *Adds subscription item-level billing periods and removes subscription-level periods* (2025-03-31.basil) — https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end
- [qbo]: Intuit, *QuickBooks Online pricing* — https://quickbooks.intuit.com/pricing/
- [xero]: Xero, *US pricing plans* — https://www.xero.com/us/pricing-plans/
- [zoho]: Zoho, *Zoho Books US pricing* — https://www.zoho.com/us/books/pricing/
- [wave]: Wave, *Pricing* — https://www.waveapps.com/pricing
- Domain registration: Verisign RDAP for `gideonbooks.com` — https://rdap.verisign.com/com/v1/domain/gideonbooks.com

[fly-pricing]: https://docs.fly.io/about/pricing
[fly-mpg]: https://docs.fly.io/postgres
[fly-mpg-product]: https://fly.io/mpg/
[fly-mpg-restore]: https://docs.fly.io/flyctl/mpg-restore
[fly-mpg-client]: https://docs.fly.io/mpg/client-configuration
[fly-config]: https://docs.fly.io/reference/configuration
[fly-domains]: https://docs.fly.io/networking/custom-domain
[fly-headers]: https://docs.fly.io/networking/request-headers
[fly-tigris]: https://docs.fly.io/tigris
[fly-js-storage]: https://docs.fly.io/js/the-basics/object-storage
[fly-machine-run]: https://docs.fly.io/flyctl/machine-run
[tigris-pricing]: https://www.tigrisdata.com/pricing/
[tigris-snapshots]: https://www.tigrisdata.com/docs/snapshots/
[tigris-s3]: https://www.tigrisdata.com/docs/api/s3/
[neon]: https://neon.com/pricing
[vercel-limits]: https://vercel.com/docs/functions/limitations
[resend]: https://resend.com/pricing
[stripe-billing]: https://stripe.com/billing/pricing
[stripe-portal]: https://docs.stripe.com/customer-management/integrate-customer-portal
[stripe-parent]: https://docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects
[stripe-periods]: https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end
[qbo]: https://quickbooks.intuit.com/pricing/
[xero]: https://www.xero.com/us/pricing-plans/
[zoho]: https://www.zoho.com/us/books/pricing/
[wave]: https://www.waveapps.com/pricing
