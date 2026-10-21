# Self-hosting Gideon Books

Gideon Books needs one PostgreSQL database and somewhere to keep attachment
files. Nothing else is required: email, bank feeds, payment providers and
exchange-rate fetching are optional, and every one has a manual path that
works without it.

## Requirements

- Node.js 22 (or Docker), PostgreSQL 14 or newer (16 is what the images and CI use).
- About 1 GB of memory for the application and worker together; more for large imports.
- A directory (or an S3-compatible bucket) for attachments.
- `pg_dump`/`pg_restore` matching the server's major version, for backups.

## Quick start with Docker Compose

```sh
cp .env.example .env
# Set at least BOOKS_ENCRYPTION_KEY (openssl rand -base64 48), APP_URL and POSTGRES_PASSWORD.
docker compose up -d          # db → migrate (runs once) → app + worker
open http://localhost:3200    # the first account to sign up is the instance administrator
```

`docker-compose.yml` runs four services from one image:

| service | what it does |
|---|---|
| `db` | PostgreSQL 16 with a named volume |
| `migrate` | applies pending migrations (`npx tsx scripts/migrate.ts`) and exits; the others wait for it |
| `app` | the web application and API on port 3200 (`next start`) |
| `worker` | background jobs and the daily schedule (`npx tsx scripts/worker.ts`) |

The `storage` volume holds attachments (`STORAGE_DIR=/data/storage`). Back it
up together with the database (see [backup-restore.md](backup-restore.md)).

## Without Docker

```sh
npm ci
cp .env.example .env.local    # fill it in
npm run db:migrate
npm run build
npm start                     # the application, port 3200
npm run worker                # in a second process (systemd, supervisor, …)
```

Run the worker under a supervisor that restarts it. Any number of workers
may run; each job runs once.

## Configuration

Every setting is an environment variable; `.env.example` lists them with
comments.

| variable | required | meaning |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `APP_URL` | yes | the public address (links in email; `https://` turns on secure cookies and HSTS) |
| `BOOKS_ENCRYPTION_KEY` | yes | 32+ random characters; encrypts provider secrets and two-step seeds. Keep it with your backups — without it, stored provider secrets cannot be read (re-enter them). Rotate with `BOOKS_ENCRYPTION_KEY_PREVIOUS`. |
| `SIGNUP_MODE` | no | `open` (default) or `invite_only` (only the first account signs up freely) |
| `EMAIL_PROVIDER` | no | `outbox` (default: nothing sent, shown as not delivered), `smtp` (`SMTP_*`), `resend` (`RESEND_API_KEY`) |
| `EMAIL_FROM` | no | sender address |
| `STORAGE_DRIVER` | no | `fs` (default, `STORAGE_DIR`) or `s3` (`S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`) |
| `ATTACHMENT_MAX_BYTES` | no | upload limit (default 20 MB) |
| `FX_PROVIDER` | no | `ecb` (default, no key) or `none` (manual rates only) |
| `HOSTED_MODE` | no | leave unset when self-hosting: no plans, limits or billing (see [hosted.md](hosted.md)) |
| `WORKER_CONCURRENCY` | no | jobs one worker runs at once (default 2) |
| `LOG_LEVEL` | no | `debug`, `info` (default), `warn`, `error` |
| `TRUST_PROXY` | no | trust `X-Forwarded-For` for client addresses (default true) |
| `DATABASE_POOL_MAX` | no | connections per process (default 10) |
| `HEALTH_MAX_QUEUE_DELAY_SECONDS` | no | readiness fails when due jobs wait longer (default 900) |

## Reverse proxy and TLS

Put the application behind a proxy that terminates TLS (Caddy, nginx,
Traefik) and forwards to port 3200. Set `APP_URL=https://books.example.com`.
Forward `X-Forwarded-For` and `X-Forwarded-Proto`. Allow request bodies of at
least 25 MB (imports and attachments). A minimal Caddyfile:

```
books.example.com {
  reverse_proxy 127.0.0.1:3200
  request_body { max_size 30MB }
}
```

## The first administrator

The first account created on a server is its instance administrator. From
the shell you can also create and manage accounts without email:

```sh
npm run admin:create-user -- --email you@example.com --name "Your Name" --admin
npm run admin:create-user -- --reset someone@example.com     # new password, signs them out everywhere
npm run admin:create-user -- --disable someone@example.com   # or --enable
```

(In Docker: `docker compose exec app npx tsx scripts/create-user.ts --reset …`.)

## Upgrades

1. Back up (`scripts/backup.sh`) and keep the backup until the upgrade is verified.
2. Pull the new version (or image) and run the migrations: `npm run db:migrate`
   (Compose does this in the `migrate` service on `docker compose up -d`).
3. Restart the application and the worker.
4. Check `/api/health/ready`: it fails until every migration on disk is applied.

Migrations are forward-only. To roll back an upgrade, restore the backup
taken in step 1.

## Health checks and logs

- `GET /api/health` — liveness (the process answers).
- `GET /api/health/ready` — readiness: database reachable, all migrations
  applied, job queue not backed up, storage writable. `503` with the failing
  check named when not ready. No configuration or secret is ever included.

Logs are one JSON object per line on stdout (errors and warnings on stderr)
with `ts`, `level`, `msg` and context fields; secret-looking fields are
redacted. Ship them with your usual collector.

## Backups

See [backup-restore.md](backup-restore.md): `scripts/backup.sh`,
`scripts/restore.sh`, and `scripts/verify-restore.sh` (run it on a schedule —
a backup you have not restored is a hope, not a backup). Each organization
can also download a complete export of its own data at any time
(Settings → Data export).
