#!/bin/sh
# Capiro Intel API container entrypoint.
#
# Modes, selected by argv:
#   serve         (default) -- start the NestJS HTTP server.
#   migrate       -- compose DATABASE_URL from DB_* secrets, run prisma migrate
#                    deploy (forward-only), then exit. The CDK migrate task
#                    definition overrides the container command to "migrate".
#   enable-feature <flag> <tenant> -- upsert an enabled feature-flag row.
#   task <verb> [args] -- run a one-off verb via dist/tasks/task-runner.js.
#   public-capture-preflight [--hearingId=...] [--limit=N]
#   public-capture-worker [--hearingId=... --captureId=...] [--limit=N]
#   public-capture-status
#
# Public capture modes drain a GLOBAL durable queue. They never accept tenant,
# client, media-URL, or credential arguments.

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
    # Fail closed. Never modify the shared migration ledger or swallow failure.
    # Repair a failed migration only through the reviewed operator runbook.
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
    # Runs as an ADMIN caller (fixed 2026-07-26). Both `tenants` and
    # `intel_feature_flag` are FORCE ROW LEVEL SECURITY with policy
    # `rls_bypass() OR <tenant match>`. This CLI set neither app.bypass_rls nor
    # app.current_tenant, so it could see ZERO tenants — surfacing as
    # `NO_TENANT_FOR_SLUG <slug> | available: ` with an EMPTY list, which reads
    # like a typo'd slug rather than an RLS wall — and passing the UUID directly
    # to skip the lookup then failed the insert with `42501: new row violates
    # row-level security policy`. Net effect: NO intel feature flag could be
    # enabled for ANY tenant by ANY means.
    #
    # Acting across tenants is this command's entire purpose (resolve any
    # tenant, write that tenant's row), so this is the intended use of the
    # existing capability, not a widening of it — the capiro_app role already
    # passes rls_bypass(); it simply has to ask.
    #
    # set_config's 3rd arg `true` scopes the setting to the TRANSACTION, so the
    # lookup and the insert must share one \$transaction: Prisma pools
    # connections, and separate raw calls can otherwise land on different ones,
    # leaving the setting behind. Mirrors readCrossTenant() in
    # apps/api/scripts/emit-redistricting-alerts.ts and sync-congress.ts.
    node -e "
      const { PrismaClient } = require('./generated/prisma-client');
      const p = new PrismaClient();
      (async () => {
        await p.\$transaction(async (tx) => {
          await tx.\$executeRawUnsafe(\"SELECT set_config('app.bypass_rls', 'on', true)\");
          let tid = '${TENANT}';
          // If not a UUID, resolve via tenants.slug
          if (!/^[0-9a-f-]{36}\$/i.test(tid)) {
            const rows = await tx.\$queryRawUnsafe('select id from tenants where slug = \$1', tid);
            if (!rows || !rows[0]) {
              const all = await tx.\$queryRawUnsafe('select slug from tenants order by slug');
              throw new Error('NO_TENANT_FOR_SLUG ' + tid + ' | available: ' + all.map(r => r.slug).join(', '));
            }
            tid = rows[0].id;
          }
          await tx.\$executeRawUnsafe(
            'insert into intel_feature_flag (id, feature, tenant_id, enabled, created_at) values (\$1,\$2,\$3,true,now()) on conflict (feature, tenant_id) do update set enabled = true',
            'ff_' + Math.random().toString(36).slice(2), '${FEATURE}', tid
          );
          console.log('FEATURE_ENABLED feature=${FEATURE} tenant=' + tid);
        });
        await p.\$disconnect();
      })().catch((e) => { console.error('SEED_ERR', e.message); process.exit(1); });
    "
    ;;
  public-capture-preflight)
    shift
    exec node dist/hearing/capture/public-capture-task-runner.js preflight "$@"
    ;;
  hearing-media)
    shift
    exec node dist/hearing/recording/run-hearing-media.js "$@"
    ;;
  hearing-delivery)
    shift
    exec node dist/hearing/run-hearing-delivery.js "$@"
    ;;
  public-capture-worker)
    shift
    exec node dist/hearing/capture/public-capture-task-runner.js worker "$@"
    ;;
  public-capture-status)
    shift
    exec node dist/hearing/capture/public-capture-task-runner.js status "$@"
    ;;
  legiwatch-phase9-capture)
    # LegiWatch Phase 9 dark runtime: global public-hearing capture worker.
    # Invoked by the DISABLED capiro-*-legiwatch-capture-worker rule and the
    # manual smokes. Allowlisted + fail-closed: exactly this compiled runner,
    # no arg-driven script path, no tenant/client/media/credential args.
    shift
    exec node dist/hearing/capture/run-phase9-public-capture.js "$@"
    ;;
  legiwatch-phase9-intelligence)
    # LegiWatch Phase 9 dark runtime: global hearing-intelligence pass.
    # Invoked by the DISABLED capiro-*-legiwatch-intelligence-worker rule and
    # the manual smokes. Allowlisted + fail-closed like the capture verb above.
    shift
    exec node dist/hearing/intelligence/run-phase9-hearing-intelligence.js "$@"
    ;;
  task)
    # task <verb> [args...] -- run a one-off maintenance/verification verb via
    # the compiled task runner. Does NOT boot the HTTP server. New verbs are
    # registered in src/tasks/task-runner.ts.
    VERB="${2:?verb required (e.g. verify-sourcedata)}"
    shift 2
    # Preserve the old operator-facing verb names while routing them away from
    # the removed process-local queue implementation.
    case "$VERB" in
      hearing-stream-preflight)
        exec node dist/hearing/capture/public-capture-task-runner.js preflight "$@"
        ;;
      hearing-capture-worker)
        exec node dist/hearing/capture/public-capture-task-runner.js worker "$@"
        ;;
      *)
        exec node dist/tasks/task-runner.js "$VERB" "$@"
        ;;
    esac
    ;;
  *)
    echo "Unknown command: $1 (expected: serve | migrate | enable-feature | public-capture-preflight | public-capture-worker | public-capture-status | legiwatch-phase9-capture | legiwatch-phase9-intelligence | task <verb>)" >&2
    exit 1
    ;;
esac
