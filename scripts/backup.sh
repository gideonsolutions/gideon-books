#!/usr/bin/env bash
# Back up Gideon Books: the database (pg_dump, custom format) and, with the
# file storage driver, the attachment directory. Writes a directory with a
# manifest of SHA-256 checksums. See docs/backup-restore.md.
#
#   DATABASE_URL=... STORAGE_DIR=./storage scripts/backup.sh [output-directory]
#
# PG_BIN may point at the PostgreSQL client binaries matching the server's
# major version (e.g. /usr/lib/postgresql/16/bin).
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL must be set}"
PG_BIN="${PG_BIN:-}"
pgdump="${PG_BIN:+$PG_BIN/}pg_dump"
OUT_ROOT="${1:-./backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DIR="$OUT_ROOT/gideon-books-$STAMP"
mkdir -p "$DIR"
umask 077

echo "Dumping the database…" >&2
"$pgdump" --format=custom --no-owner --no-privileges --file "$DIR/database.dump" "$DATABASE_URL"

STORAGE_DRIVER="${STORAGE_DRIVER:-fs}"
if [ "$STORAGE_DRIVER" = "fs" ]; then
  SRC="${STORAGE_DIR:-./storage}"
  if [ -d "$SRC" ]; then
    echo "Archiving attachments from $SRC…" >&2
    tar -czf "$DIR/storage.tar.gz" -C "$SRC" .
  else
    echo "No storage directory at $SRC; nothing to archive." >&2
  fi
elif [ "$STORAGE_DRIVER" = "none" ]; then
  echo "Skipping attachments (database-only backup)." >&2
else
  echo "Attachments are in object storage ($STORAGE_DRIVER); back the bucket up with the store's own versioning or replication." >&2
fi

MIGRATION="$(node -e 'try{const j=require(process.argv[1]);console.log(j.entries[j.entries.length-1].tag)}catch{console.log("unknown")}' "$(cd "$(dirname "$0")/.." && pwd)/lib/db/migrations/meta/_journal.json")"
{
  echo "{"
  echo "  \"format\": \"gideon-books-backup\","
  echo "  \"createdAt\": \"$STAMP\","
  echo "  \"schemaMigration\": \"$MIGRATION\","
  echo "  \"storageDriver\": \"$STORAGE_DRIVER\","
  echo "  \"files\": {"
  first=1
  for f in "$DIR"/database.dump "$DIR"/storage.tar.gz; do
    [ -f "$f" ] || continue
    sum="$(sha256sum "$f" | cut -d' ' -f1)"
    [ $first -eq 1 ] || echo ","
    printf '    "%s": "%s"' "$(basename "$f")" "$sum"
    first=0
  done
  echo ""
  echo "  }"
  echo "}"
} > "$DIR/manifest.json"
echo "$DIR"
