#!/usr/bin/env bash
# Run tests with a run tag so concurrent runs clean up only their own databases.
set -euo pipefail
export TEST_RUN_TAG="r$(date +%s)$$"
cleanup() {
  psql "${TEST_DATABASE_URL:-postgres://books:books@localhost:54329/postgres}" -Atc "select datname from pg_database where datname like 'books_t_%_${TEST_RUN_TAG}'" 2>/dev/null | while read -r db; do
    psql "${TEST_DATABASE_URL:-postgres://books:books@localhost:54329/postgres}" -qc "drop database if exists \"$db\" with (force)" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT
# One test run at a time on this machine (each run uses several worker processes).
flock /tmp/gideon-books-test.lock npx vitest run "$@"
