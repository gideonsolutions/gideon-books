#!/usr/bin/env bash
# Development only, before the first release: rebuild the migration history
# as one generated schema migration plus the hand-written integrity rules.
# After a release, add migrations with `npm run db:generate` instead.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf lib/db/migrations
npx drizzle-kit generate --name=schema >/dev/null
npx drizzle-kit generate --custom --name=integrity >/dev/null
target=$(ls lib/db/migrations/*_integrity.sql)
# The core rules first (integrity-00-core.sql), then each module's, separated as statements.
first=1
: > "$target"
for f in $(ls lib/db/sql/integrity*.sql | sort); do
  if [ $first -eq 0 ]; then printf '\n--> statement-breakpoint\n' >> "$target"; fi
  printf -- '-- %s\n' "$f" >> "$target"
  cat "$f" >> "$target"
  first=0
done
ls lib/db/migrations
