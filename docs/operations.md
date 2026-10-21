# Operations runbook

## Processes

| process | command | notes |
|---|---|---|
| web application | `npm start` / `next start --port 3200` | stateless; run several behind a load balancer if needed |
| worker | `npm run worker` | claims jobs with `FOR UPDATE SKIP LOCKED`; any number can run; `WORKER_CONCURRENCY` per process |
| migrations | `npm run db:migrate` | before starting a new version; idempotent |

The worker also enqueues the daily schedule (once per UTC day, deduplicated
across workers): automatic reversals, exchange-rate fetching for
organizations using foreign currencies, recurring invoices and bills, bank
feed syncs, and — in the first three days of a month — preparing each
organization's depreciation run for review.

## Jobs

Settings → Background jobs shows each organization's jobs. A failed job
retries after 30 s, 1 min, 2 min, … (doubling, capped at 6 hours) until its
attempt limit, then is marked **dead** and waits for a person: fix the cause
(for example a provider credential) and press *Retry*. A job whose worker
died mid-run is reclaimed after `JOB_STALE_SECONDS` (default 900). Handlers
are idempotent: re-running a job never double-posts (postings carry
idempotency keys; recurring documents are unique per occurrence).

Queue health is part of `/api/health/ready`: it fails when due jobs have
waited longer than `HEALTH_MAX_QUEUE_DELAY_SECONDS` (default 900) — usually
because no worker is running.

## Health and alerting

Alert on: `/api/health/ready` non-200 for more than a few minutes; any `"level":"error"`
log line; dead jobs (`select count(*) from jobs where status = 'dead' and finished_at > now() - interval '1 day'`);
`scripts/verify-restore.sh` failing.

## Common situations

| symptom | what to do |
|---|---|
| readiness: migrations not applied | run `npm run db:migrate` (or restart the Compose `migrate` service) |
| readiness: jobs backed up | start or restart the worker; check its logs |
| readiness: storage | check `STORAGE_DIR` exists and is writable by the app user, or the S3 credentials |
| emails show "not delivered" | `EMAIL_PROVIDER` is `outbox`; configure SMTP or Resend |
| a provider connection shows an error | open Settings → Integrations; reconnect; retry the dead job |
| someone is locked out | `npm run admin:create-user -- --reset their@email` |
| books need a correction in a closed period | an accountant reopens the period (with a reason, recorded) — never edit the database |

## Data protection

- Provider secrets and two-step seeds are encrypted with `BOOKS_ENCRYPTION_KEY`.
- Posted entries, stock moves, settlements, audit events and the cash-basis
  projection are protected by database triggers: not even a direct SQL
  statement can change them. The only bypass is the owner-requested deletion
  of an entire organization (`gideon.allow_purge`, set for that transaction only).
- Attachments are served only through an authorized route, as downloads, with
  `nosniff` and a sandboxing content security policy.

## Backups

Follow [backup-restore.md](backup-restore.md). Minimum: a daily
`scripts/backup.sh`, copied off the server, and a weekly
`scripts/verify-restore.sh`.
