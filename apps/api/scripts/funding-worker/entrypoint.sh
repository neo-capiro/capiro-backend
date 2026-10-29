#!/bin/sh
# Run this entrypoint in the exact qualified ARM64 Core image.
set -eu
case "${1:-}" in
  sync-tango-funding|embed-funding-catalog|sync-tango-opportunity-attachments) script="$1"; shift ;;
  *) echo 'Usage: funding-worker/entrypoint.sh sync-tango-funding|embed-funding-catalog|sync-tango-opportunity-attachments [options]' >&2; exit 64 ;;
esac
if [ -z "${DATABASE_URL:-}" ]; then
  DATABASE_URL="$(node /app/apps/api/scripts/lib/pe-compose-database-url.js)"
  export DATABASE_URL
fi
export NODE_EXTRA_CA_CERTS=/app/apps/api/scripts/funding-worker/rds-global-bundle.pem
export TMPDIR="${TMPDIR:-/dev/shm}"
cd /app/apps/api
exec ./node_modules/.bin/tsx "scripts/$script.ts" "$@"
