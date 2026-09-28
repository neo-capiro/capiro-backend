#!/bin/sh
# Capiro Strategy API (api-strategy) container entrypoint.
#
# Modes, selected by argv:
#   serve                     (default) start the NestJS HTTP server.
#   migrate                   compose DATABASE_URL from DB_* secrets, run
#                             prisma migrate deploy (forward-only), then seed
#                             the global reference baseline (insert-if-empty),
#                             then exit. The CDK migrate task definition
#                             overrides the container command to "migrate".
#   seed                      seed the global reference baseline only.
#   update-strategy-reference replace the global reference baseline from
#                             STRATEGY_REFERENCE_FILE / STRATEGY_REFERENCE_JSON
#                             (the Capiro-maintained ops verb, FND-8).
#
# DATABASE_URL is composed from the individual DB_* secrets injected by ECS from
# the Aurora credential. sslmode=require because Aurora's parameter group has
# rds.force_ssl=1. (Mirrors apps/workspace + apps/api.)

set -e

# Compose DATABASE_URL from DB_* secrets when not already provided.
if [ -z "$DATABASE_URL" ]; then
  if [ -z "$DB_HOST" ] || [ -z "$DB_PORT" ] || [ -z "$DB_USER" ] || [ -z "$DB_PASSWORD" ] || [ -z "$DB_NAME" ]; then
    echo "Missing DB_* env vars (got DB_HOST=$DB_HOST DB_PORT=$DB_PORT DB_USER=$DB_USER DB_NAME=$DB_NAME)" >&2
    exit 1
  fi
  # URL-encode the password using node (always present in this image).
  ENCODED_PASSWORD=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$DB_PASSWORD")
  export DATABASE_URL="postgresql://${DB_USER}:${ENCODED_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}?schema=public&sslmode=require"
fi

# tsx writes its compile cache under TMPDIR; default to tmpfs if unset.
: "${TMPDIR:=/dev/shm}"
export TMPDIR

case "${1:-serve}" in
  migrate)
    echo "Running prisma migrate deploy (api-strategy engine)"
    # Stop on failed migrations. Ledger recovery requires a reviewed procedure.
    node node_modules/prisma/build/index.js migrate deploy
    # Seed the global reference baseline (insert-if-empty; never clobbers
    # ops-verb edits) after migrating.
    echo "Seeding global reference baseline"
    exec node dist/seed.js
    ;;
  seed)
    echo "Seeding global reference baseline (api-strategy engine)"
    exec node dist/seed.js
    ;;
  update-strategy-reference)
    echo "Replacing global reference baseline from ops payload"
    exec node dist/reference-ops.js
    ;;
  serve)
    echo "Starting Capiro Strategy API"
    exec node dist/main.js
    ;;
  *)
    echo "Unknown command: $1 (expected: serve | migrate | seed | update-strategy-reference)" >&2
    exit 1
    ;;
esac
