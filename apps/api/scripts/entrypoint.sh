#!/bin/sh
# Phase-A safety wrapper for the API container entrypoint.
#
# It owns the two trust-critical verbs that must not pass through the legacy
# entrypoint behavior: migration deployment (fail closed; never edits Prisma's
# migration ledger) and the read-only PE trust diagnostic. Every other command
# delegates byte-for-byte to the existing dispatcher.
set -e

compose_database_url() {
  if [ -z "$DB_HOST" ] || [ -z "$DB_PORT" ] || [ -z "$DB_USER" ] || [ -z "$DB_PASSWORD" ] || [ -z "$DB_NAME" ]; then
    echo "Missing DB_* env vars (got DB_HOST=$DB_HOST DB_PORT=$DB_PORT DB_USER=$DB_USER DB_NAME=$DB_NAME)" >&2
    exit 1
  fi
  ENCODED_PASSWORD=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$DB_PASSWORD")
  export DATABASE_URL="postgresql://${DB_USER}:${ENCODED_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}?schema=public&sslmode=require&connection_limit=10"
  : "${TMPDIR:=/dev/shm}"
  export TMPDIR
  # The diagnostic must never substitute an ECS metadata URI for a Git commit.
  # Deployment automation may set a real GIT_SHA; otherwise report UNVERIFIED.
  : "${GIT_SHA:=UNVERIFIED}"
  export GIT_SHA
}

case "${1:-serve}" in
  migrate)
    compose_database_url
    echo "Running prisma migrate deploy (failed migration history is never auto-resolved)"
    node ./node_modules/prisma/build/index.js migrate deploy --schema=./prisma/schema.prisma
    echo "Seeding workflow templates"
    exec ./node_modules/.bin/tsx prisma/seed-workflows.ts
    ;;
  diag-pe-trust)
    shift
    compose_database_url
    echo "Running diag-pe-trust (SELECT-only Program Elements trust baseline)"
    exec ./node_modules/.bin/tsx scripts/diag-program-element-trust-baseline.ts "$@"
    ;;
  *)
    exec /bin/sh /usr/local/lib/capiro/entrypoint-legacy.sh "$@"
    ;;
esac
