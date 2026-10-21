#!/usr/bin/env bash
# Development only: drop and recreate the DATABASE_URL database straight from
# the current schema (drizzle-kit push) plus lib/db/sql/integrity*.sql.
# Never point this at a database with real books.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DATABASE_URL:?set DATABASE_URL}"
db=$(node -e 'console.log(new URL(process.env.DATABASE_URL).pathname.slice(1))')
admin=$(node -e 'const u=new URL(process.env.DATABASE_URL);u.pathname="/postgres";console.log(u.toString())')
psql "$admin" -qc "drop database if exists \"$db\" with (force)" -c "create database \"$db\""
npx drizzle-kit push --force >/dev/null
for f in $(ls lib/db/sql/integrity*.sql | sort); do
  node -e '
    const fs=require("fs"); const {Client}=require("pg");
    (async()=>{const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
      for (const s of fs.readFileSync(process.argv[1],"utf8").split("--> statement-breakpoint")) if (s.trim()) await c.query(s);
      await c.end();})().catch(e=>{console.error(process.argv[1], e.message);process.exit(1)});' "$f"
done
echo "reset $db"
