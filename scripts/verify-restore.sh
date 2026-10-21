#!/usr/bin/env bash
# Prove a backup can be restored: back up DATABASE_URL, restore it into a
# scratch database on the same server, compare every table's row count and
# every organization's trial balance with the source, then drop the scratch
# database. Exits non-zero on any difference. Run it on a schedule.
#
#   DATABASE_URL=... scripts/verify-restore.sh
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL must be set}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
SCRATCH="books_restore_check_$(date -u +%Y%m%d%H%M%S)_$$"
ADMIN_URL="$(node -e 'const u=new URL(process.argv[1]); u.pathname="/postgres"; console.log(u.toString())' "$DATABASE_URL")"
TARGET_URL="$(node -e 'const u=new URL(process.argv[1]); u.pathname="/"+process.argv[2]; console.log(u.toString())' "$DATABASE_URL" "$SCRATCH")"
cleanup() {
  psql "$ADMIN_URL" -qc "drop database if exists \"$SCRATCH\" with (force)" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

BACKUP_DIR="$(STORAGE_DRIVER=none "$ROOT/scripts/backup.sh" "$WORK")"
psql "$ADMIN_URL" -qc "create database \"$SCRATCH\""
"$ROOT/scripts/restore.sh" "$BACKUP_DIR" "$TARGET_URL" "$WORK/storage"
(cd "$ROOT" && npx tsx scripts/ops-compare.ts "$DATABASE_URL" "$TARGET_URL")
