#!/usr/bin/env bash
# Restore a backup made by scripts/backup.sh into an EMPTY database, check
# the files against the manifest first, restore the attachments, and check
# that every organization's ledger balances. See docs/backup-restore.md.
#
#   scripts/restore.sh <backup-directory> <target-database-url> [target-storage-dir]
set -euo pipefail
BACKUP="${1:?backup directory}"
TARGET="${2:?target database url}"
TARGET_STORAGE="${3:-${STORAGE_DIR:-./storage}}"
PG_BIN="${PG_BIN:-}"
pgrestore="${PG_BIN:+$PG_BIN/}pg_restore"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

[ -f "$BACKUP/manifest.json" ] || { echo "No manifest.json in $BACKUP" >&2; exit 1; }
echo "Checking checksums…" >&2
node -e '
  const fs = require("fs"), crypto = require("crypto"), path = require("path");
  const dir = process.argv[1];
  const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  for (const [f, sum] of Object.entries(m.files)) {
    const got = crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, f))).digest("hex");
    if (got !== sum) { console.error(f + " does not match its checksum"); process.exit(1); }
  }
' "$BACKUP"

existing="$(psql "$TARGET" -Atc "select count(*) from information_schema.tables where table_schema = 'public'")"
if [ "$existing" != "0" ]; then
  echo "The target database is not empty ($existing tables). Restore into a new, empty database." >&2
  exit 1
fi

echo "Restoring the database…" >&2
"$pgrestore" --no-owner --no-privileges --exit-on-error --dbname "$TARGET" "$BACKUP/database.dump"

if [ -f "$BACKUP/storage.tar.gz" ]; then
  echo "Restoring attachments into $TARGET_STORAGE…" >&2
  mkdir -p "$TARGET_STORAGE"
  tar -xzf "$BACKUP/storage.tar.gz" -C "$TARGET_STORAGE"
fi

echo "Checking the restored ledgers…" >&2
(cd "$ROOT" && npx tsx scripts/ops-compare.ts --check "$TARGET")
echo "Restore complete." >&2
