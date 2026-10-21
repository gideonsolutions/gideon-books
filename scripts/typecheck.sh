#!/usr/bin/env bash
# Type-check, one run at a time on this machine (tsc on the whole project is memory-hungry).
set -uo pipefail
cd "$(dirname "$0")/.."
exec flock /tmp/gideon-books-tsc.lock npx tsc --noEmit -p tsconfig.json "$@"
