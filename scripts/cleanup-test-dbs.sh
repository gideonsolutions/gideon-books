#!/usr/bin/env bash
# Drop leftover test databases and old templates on the test server.
set -euo pipefail
URL="${TEST_DATABASE_URL:-postgres://books:books@localhost:54329/postgres}"
psql "$URL" -Atc "select datname from pg_database where datname like 'books_t_%' or datname like 'books_tpl_%'" | while read -r db; do
  psql "$URL" -qc "drop database if exists \"$db\" with (force)" || true
done
