#!/bin/sh
# Capiro Workspace container entrypoint.
#
# Modes, selected by argv:
#   serve    (default) -- start the NestJS HTTP server.
#   migrate  -- compose DATABASE_URL from DB_* secrets, run prisma migrate
#               deploy (forward-only), then exit. The CDK migrate task
#               definition overrides the container command to "migrate".
#
# In both modes we compose DATABASE_URL from the individual DB_* secrets
# injected by ECS from the Aurora credential. We require sslmode=require
# because Aurora's parameter group has rds.force_ssl=1. (Mirrors apps/api.)

set -e

# Compose DATABASE_URL from DB_* secrets when not already provided.
if [ -z "$DATABASE_URL" ]; then
  if [ -z "$DB_HOST" ] || [ -z "$DB_PORT" ] || [ -z "$DB_USER" ] || [ -z "$DB_PASSWORD" ] || [ -z "$DB_NAME" ]; then
    echo "Missing DB_* env vars (got DB_HOST=$DB_HOST DB_PORT=$DB_PORT DB_USER=$DB_USER DB_NAME=$DB_NAME)" >&2
    exit 1
  fi
  # URL-encode the password using node (always present in this image).
  ENCODED_PASSWORD=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$DB_PASSWORD")
  # connection_limit/pool_timeout: Prisma's default pool on a 0.25-vCPU task is
  # a handful of connections with a 10s wait. The TenantGuard's tenant lookup
  # shares that pool with every request's own transaction, so under modest
  # concurrency it timed out and failed closed (403 "No tenant for the supplied
  # identifiers", 2026-09-02). Ten connections + a 20s wait keeps the guard fed.
  export DATABASE_URL="postgresql://${DB_USER}:${ENCODED_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}?schema=public&sslmode=require&connection_limit=10&pool_timeout=20"
fi

# tsx writes its compile cache under TMPDIR; default to tmpfs if unset.
: "${TMPDIR:=/dev/shm}"
export TMPDIR

case "${1:-serve}" in
  migrate)
    echo "Running prisma migrate deploy (workspace engine)"
    # Stop on failed migrations. Ledger recovery requires a reviewed procedure.
    node node_modules/prisma/build/index.js migrate deploy
    # Seed the global template catalog (idempotent upsert) after migrating.
    echo "Seeding global template catalog"
    exec node dist/seed.js
    ;;
  seed)
    echo "Seeding global template catalog (workspace engine)"
    exec node dist/seed.js
    ;;
  serve)
    echo "Starting Capiro Workspace"
    exec node dist/main.js
    ;;
  *)
    echo "Unknown command: $1 (expected: serve | migrate)" >&2
    exit 1
    ;;
esac
