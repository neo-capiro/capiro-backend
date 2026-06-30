#!/bin/sh
# Capiro MeriV2 Orchestrator container entrypoint.
#
# Modes (argv):
#   serve  (default) -- start the NestJS HTTP server (port 4300).
#
# The orchestrator does NOT own a Prisma schema or migrations (those belong to
# apps/api); it composes DATABASE_URL from the DB_* secrets ECS injects so the
# MeriContext user lookup + future Prisma-native tools can reach the shared DB.
# sslmode=require because Aurora's parameter group sets rds.force_ssl=1.

set -e

if [ -z "$DATABASE_URL" ]; then
  if [ -z "$DB_HOST" ] || [ -z "$DB_PORT" ] || [ -z "$DB_USER" ] || [ -z "$DB_PASSWORD" ] || [ -z "$DB_NAME" ]; then
    echo "Missing DB_* env vars (got DB_HOST=$DB_HOST DB_PORT=$DB_PORT DB_USER=$DB_USER DB_NAME=$DB_NAME)" >&2
    exit 1
  fi
  ENCODED_PASSWORD=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$DB_PASSWORD")
  export DATABASE_URL="postgresql://${DB_USER}:${ENCODED_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}?schema=public&sslmode=require"
fi

: "${TMPDIR:=/dev/shm}"
export TMPDIR

case "${1:-serve}" in
  serve)
    echo "Starting Capiro MeriV2 Orchestrator"
    exec node dist/main.js
    ;;
  *)
    echo "Unknown command: $1 (expected: serve)" >&2
    exit 1
    ;;
esac
