#!/bin/sh
# Capiro Onboard API container entrypoint.
#
# Modes, selected by argv:
#   serve         (default) -- start the NestJS HTTP server (API + SPA).
#   migrate       -- compose DATABASE_URL from DB_* secrets, run prisma migrate
#                    deploy (forward-only), then exit. The migrate task
#                    definition overrides the container command to "migrate".
#   task <verb> [args] -- run a one-off verb via dist/tasks/task-runner.js
#                    (e.g. "task lifecycle-daily"). Does not serve. The daily
#                    lifecycle cron (EventBridge -> RunTask) uses this.
#
# DATABASE_URL is composed from the individual DB_* secrets injected by ECS
# from the Aurora credential. sslmode=require because Aurora's parameter group
# has rds.force_ssl=1. (Mirrors apps/api and apps/intel-api.)

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
  migrate)
    echo "Running prisma migrate deploy (onboard-api)"
    # Auto-resolve any previously failed onboard migrations before deploying,
    # so a stuck failed entry doesn't block forward progress. Scoped to
    # migrations named *_onboard_* — this service must never touch other
    # services' rows in the shared _prisma_migrations table.
    node -e "
      const { PrismaClient } = require('./generated/prisma-client');
      const p = new PrismaClient();
      (async () => {
        try {
          const failed = await p.\$queryRaw\`
            SELECT migration_name FROM _prisma_migrations
            WHERE finished_at IS NULL AND rolled_back_at IS NULL
              AND migration_name LIKE '%_onboard_%'
          \`;
          for (const row of failed) {
            console.log('Resolving failed onboard migration:', row.migration_name);
            await p.\$executeRaw\`
              UPDATE _prisma_migrations
              SET rolled_back_at = NOW()
              WHERE migration_name = \${row.migration_name}
            \`;
          }
        } catch (e) {
          console.log('Pre-migrate check skipped:', e.message);
        } finally {
          await p.\$disconnect();
        }
      })();
    " || true
    exec node node_modules/prisma/build/index.js migrate deploy
    ;;
  serve)
    echo "Starting Capiro Onboard API"
    exec node dist/main.js
    ;;
  task)
    VERB="${2:?verb required (e.g. lifecycle-daily)}"
    shift 2
    exec node dist/tasks/task-runner.js "$VERB" "$@"
    ;;
  *)
    echo "Unknown command: $1 (expected: serve | migrate | task <verb>)" >&2
    exit 1
    ;;
esac
