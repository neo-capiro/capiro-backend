#!/bin/sh
# engagement-api container entrypoint — serve-only.
#
# The engagement-api image never owns migrations. It refuses every verb
# except `serve`. This is a hard fail-closed boundary: the image cannot
# run prisma migrate, prisma seed, sync-*, diag-*, or any operational
# script that the main API entrypoint supports.
set -e

compose_database_url() {
  if [ -z "$DB_HOST" ] || [ -z "$DB_PORT" ] || [ -z "$DB_USER" ] || [ -z "$DB_PASSWORD" ] || [ -z "$DB_NAME" ]; then
    echo "Missing DB_* env vars (got DB_HOST=$DB_HOST DB_PORT=$DB_PORT DB_USER=$DB_USER DB_NAME=$DB_NAME)" >&2
    exit 1
  fi
  COMPOSE_HELPER="${PE_COMPOSE_DATABASE_URL_JS:-/app/apps/api/scripts/lib/pe-compose-database-url.js}"
  if [ ! -f "$COMPOSE_HELPER" ]; then
    if [ -f "./scripts/lib/pe-compose-database-url.js" ]; then
      COMPOSE_HELPER="./scripts/lib/pe-compose-database-url.js"
    elif [ -f "./lib/pe-compose-database-url.js" ]; then
      COMPOSE_HELPER="./lib/pe-compose-database-url.js"
    fi
  fi
  export DATABASE_URL="$(node "$COMPOSE_HELPER")"
  # Fargate tsx IPC: prefer writable tmpfs /dev/shm (production one-off pattern).
  # Fall back to /app/tmp (Dockerfile). Never default bare /tmp (ENOENT mkdir tsx-UID).
  if [ -d /dev/shm ] && touch /dev/shm/.capiro_w 2>/dev/null; then
    rm -f /dev/shm/.capiro_w 2>/dev/null || true
    export TMPDIR=/dev/shm
  elif [ -d /app/tmp ] || mkdir -p /app/tmp 2>/dev/null; then
    export TMPDIR=/app/tmp
  else
    : "${TMPDIR:=/dev/shm}"
    export TMPDIR
  fi
}

case "${1:-serve}" in
  serve)
    # Compose DATABASE_URL from DB_* parts if not already supplied.
    if [ -z "$DATABASE_URL" ]; then
      compose_database_url
    fi
    # Require the service name to be set. Config validation enforces the
    # full shadow matrix; this is just a clear message if the env is missing.
    : "${CAPIRO_SERVICE_NAME:=engagement-api}"
    export CAPIRO_SERVICE_NAME
    echo "Starting engagement-api (serve-only; service=$CAPIRO_SERVICE_NAME)"
    exec node dist/engagement-main.js
    ;;
  migrate|migration-status|seed|seed-workflows|sync-*|diag-*)
    echo "engagement-api entrypoint refuses: $1" >&2
    echo "The engagement-api image is serve-only and never owns migrations or operational scripts." >&2
    exit 64
    ;;
  *)
    echo "engagement-api entrypoint: unknown command '$1'" >&2
    echo "Supported commands: serve" >&2
    exit 64
    ;;
esac
