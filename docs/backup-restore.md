# Backups and verified restore

Two layers:

1. **Server backups** (the operator's job): the whole database plus the
   attachment files, with `scripts/backup.sh`, restored with
   `scripts/restore.sh`, and proven restorable with `scripts/verify-restore.sh`.
2. **Organization exports** (each organization's own): a complete, documented
   ZIP of one organization's data and files, from Settings → Data export
   ([data-export-format.md](data-export-format.md)). An export can be imported
   into a new organization on the same or another server.

## Back up

```sh
DATABASE_URL=postgres://… STORAGE_DIR=/data/storage scripts/backup.sh /backups
```

Writes `/backups/gideon-books-<UTC timestamp>/` with:

- `database.dump` — `pg_dump --format=custom` of the whole database;
- `storage.tar.gz` — the attachment directory (file storage driver only; with
  `STORAGE_DRIVER=s3`, use the bucket's versioning/replication instead);
- `manifest.json` — schema migration, storage driver, SHA-256 of each file.

Use client tools matching the server's major version: `PG_BIN=/usr/lib/postgresql/16/bin`.
Keep `BOOKS_ENCRYPTION_KEY` with the backups (separately and safely): it
decrypts stored provider secrets.

Run it daily from cron or a systemd timer, copy the directory off the
server, and keep several generations.

## Restore

```sh
createdb -h … newbooks                      # an EMPTY database
scripts/restore.sh /backups/gideon-books-20261021T030000Z postgres://…/newbooks /data/storage
```

The script refuses a target that already has tables, checks every file
against the manifest, restores with `pg_restore --exit-on-error`, unpacks the
attachments, and checks that every organization's ledger balances. Point
`DATABASE_URL` at the restored database and start the application; the
readiness check confirms the migrations.

## Verify a restore (the procedure that proves the backups work)

```sh
DATABASE_URL=postgres://…/books PG_BIN=/usr/lib/postgresql/16/bin scripts/verify-restore.sh
```

It backs up the database, restores it into a scratch database on the same
server, compares **every table's row count and every organization's trial
balance** with the source (`scripts/ops-compare.ts`), drops the scratch
database, and exits non-zero on any difference. CI runs it on every change;
run it on a schedule against production (it needs permission to create a
database). The automated test `tests/ops/backup-restore.test.ts` does the
same against a test database.

## Organization export, import and deletion

- **Export**: Settings → Data export → *Export everything* (accountant role or
  above). Built by a background job; downloadable when complete; audited.
- **Import**: Settings → Data export → *Import* (administrator) creates a new
  organization from an export, owned by the person importing.
- **Delete**: the owner only. A demonstration company is deleted at once; a
  real organization only after typing its name and either completing an
  export or explicitly declining one. Every row and file of that organization
  is removed in one transaction; an instance-level audit event records it.
