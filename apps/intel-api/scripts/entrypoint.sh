#!/bin/sh
# Capiro Intel API container entrypoint.
#
# Modes, selected by argv:
#   serve         (default) -- start the NestJS HTTP server.
#   migrate       -- compose DATABASE_URL from DB_* secrets, run prisma migrate
#                    deploy (forward-only), then exit. The CDK migrate task
#                    definition overrides the container command to "migrate".
#   enable-feature <flag> <tenant> -- upsert an enabled feature-flag row.
#   task <verb> [args] -- run a one-off verb via dist/tasks/task-runner.js
#                    (e.g. "task verify-sourcedata 119-hr-1"). Does not serve.
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
  ENCODED_PASSWORD=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$DB_PASSWORD")
  export DATABASE_URL="postgresql://${DB_USER}:${ENCODED_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}?schema=public&sslmode=require"
fi

# tsx writes its compile cache under TMPDIR; default to tmpfs if unset.
: "${TMPDIR:=/dev/shm}"
export TMPDIR

case "${1:-serve}" in
  migrate)
    echo "Running prisma migrate deploy (intel-api)"
    # Auto-resolve any previously failed migrations before deploying, so a
    # stuck failed entry doesn't block forward progress. (Mirrors apps/api.)
    node -e "
      const { PrismaClient } = require('./generated/prisma-client');
      const p = new PrismaClient();
      (async () => {
        try {
          const failed = await p.\$queryRaw\`
            SELECT migration_name FROM _prisma_migrations
            WHERE finished_at IS NULL AND rolled_back_at IS NULL
          \`;
          for (const row of failed) {
            console.log('Resolving failed migration:', row.migration_name);
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
    echo "Starting Capiro Intel API"
    exec node dist/main.js
    ;;
  enable-feature)
    # enable-feature <feature> <tenant-slug-or-id>: upsert an enabled feature
    # flag row for a tenant. Resolves a tenant slug to its UUID via the shared
    # `tenants` table (intel-api shares the api's Aurora DB). Admin one-off.
    FEATURE="${2:?feature required}"
    TENANT="${3:?tenant slug or id required}"
    node -e "
      const { PrismaClient } = require('./generated/prisma-client');
      const p = new PrismaClient();
      (async () => {
        let tid = '${TENANT}';
        // If not a UUID, resolve via tenants.slug
        if (!/^[0-9a-f-]{36}\$/i.test(tid)) {
          const rows = await p.\$queryRawUnsafe('select id from tenants where slug = \$1', tid);
          if (!rows || !rows[0]) {
            const all = await p.\$queryRawUnsafe('select slug from tenants order by slug');
            console.error('NO_TENANT_FOR_SLUG ' + tid + ' | available: ' + all.map(r => r.slug).join(', '));
            process.exit(1);
          }
          tid = rows[0].id;
        }
        await p.\$executeRawUnsafe(
          'insert into intel_feature_flag (id, feature, tenant_id, enabled, created_at) values (\$1,\$2,\$3,true,now()) on conflict (feature, tenant_id) do update set enabled = true',
          'ff_' + Math.random().toString(36).slice(2), '${FEATURE}', tid
        );
        console.log('FEATURE_ENABLED feature=${FEATURE} tenant=' + tid);
        await p.\$disconnect();
      })().catch((e) => { console.error('SEED_ERR', e.message); process.exit(1); });
    "
    ;;
  task)
    # task <verb> [args...] -- run a one-off maintenance/verification verb via
    # the compiled task runner. Does NOT boot the HTTP server. New verbs are
    # registered in src/tasks/task-runner.ts (Phase 1 verb: verify-sourcedata).
    # Invoked through the verb-runner task-def family
    # (capiro-*-intel-api-enableflag) with a `command` containerOverride, e.g.
    #   ["task","verify-sourcedata","119-hr-1"]
    VERB="${2:?verb required (e.g. verify-sourcedata)}"
    shift 2
    exec node dist/tasks/task-runner.js "$VERB" "$@"
    ;;
  *)
    echo "Unknown command: $1 (expected: serve | migrate | enable-feature | task <verb>)" >&2
    exit 1
    ;;
esac
