#!/bin/sh
# Program Elements and MeriV2 trust-safety wrapper for the API container entrypoint.
#
# It owns the trust-critical verbs that must not pass through the legacy
# entrypoint behavior: migration status/deployment (fail closed; never edits
# Prisma's migration ledger), SELECT-only diagnostics, and bounded operational
# monitors. Every other command delegates byte-for-byte to the existing dispatcher.
set -e

compose_database_url() {
  if [ -z "$DB_HOST" ] || [ -z "$DB_PORT" ] || [ -z "$DB_USER" ] || [ -z "$DB_PASSWORD" ] || [ -z "$DB_NAME" ]; then
    echo "Missing DB_* env vars (got DB_HOST=$DB_HOST DB_PORT=$DB_PORT DB_USER=$DB_USER DB_NAME=$DB_NAME)" >&2
    exit 1
  fi
  # Real URL via node helper (image path). Never embed a masked password marker here.
  # entrypoint is installed at /usr/local/bin; helper lives with scripts in the image.
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
  # Diagnostics must never substitute an ECS metadata URI for a Git commit.
  # Deployment automation may set a real GIT_SHA; otherwise report UNVERIFIED.
  : "${GIT_SHA:=UNVERIFIED}"
  export GIT_SHA
}

case "${1:-serve}" in
  migration-status)
    compose_database_url
    echo "Running prisma migrate status (READ-ONLY; migration history is never edited)"
    exec node ./node_modules/prisma/build/index.js migrate status --schema=./prisma/schema.prisma
    ;;
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
  audit-llamaparse-pe-units)
    shift
    compose_database_url
    echo "Running audit-llamaparse-pe-units (SELECT-only historical money-unit evidence report)"
    exec ./node_modules/.bin/tsx scripts/audit-llamaparse-pe-units.ts "$@"
    ;;
  pe-phase-10-live-proofs)
    shift
    compose_database_url
    # Fargate non-root: tsx IPC needs a real tmpfs. Production one-offs use TMPDIR=/dev/shm
    # (see set-tenant-flag / sync-hearing-transcripts). /tmp and even baked /app/tmp can
    # ENOENT on mkdir $TMPDIR/tsx-1001 under some Fargate mounts.
    if [ -d /dev/shm ] && touch /dev/shm/.pe10_w 2>/dev/null; then
      rm -f /dev/shm/.pe10_w 2>/dev/null || true
      export TMPDIR=/dev/shm
    else
      mkdir -p /app/tmp 2>/dev/null || true
      export TMPDIR=/app/tmp
    fi
    export TSX_TSCONFIG_PATH="${TSX_TSCONFIG_PATH:-./tsconfig.json}"
    echo "Running pe-phase-10-live-proofs (sole-live Aurora; synthetic pe10_closeout domain only; TMPDIR=$TMPDIR)"
    exec ./node_modules/.bin/tsx scripts/pe-phase-10-live-proofs.ts "$@"
    ;;
  emit-meriv2-control-metrics)
    shift
    compose_database_url
    echo "Running emit-meriv2-control-metrics (read-only bounded control snapshot)"
    exec ./node_modules/.bin/tsx scripts/emit-meriv2-control-metrics.ts "$@"
    ;;
  demo-meriv2-control-alarms)
    shift
    echo "Running demo-meriv2-control-alarms (refuses dev/prod; explicit non-prod confirmation required)"
    exec ./node_modules/.bin/tsx scripts/demo-meriv2-control-alarms.ts "$@"
    ;;
  # Phase 7 Workstream N. Trust-critical promotion-operator verbs belong here,
  # not in entrypoint-dispatcher.inc — that file is the frozen legacy include
  # Workstream M's containment gate wraps, not where new promotion verbs go
  # (docs/defense-budget/PHASE-7-PRE-IMPLEMENTATION-DEPENDENCY-MAP.md §4). Only
  # two of the plan's eight promotion verbs are wired as of session 7 —
  # plan/validate/authorize/execute/compare/rollback are not yet built; see the
  # session-7 handoff for the exact construction pattern to follow.
  status-defense-budget-promotion-v1)
    shift
    compose_database_url
    echo "Running status-defense-budget-promotion-v1 (READ-ONLY; no write statement issued)"
    exec ./node_modules/.bin/tsx scripts/status-defense-budget-promotion-v1.ts "$@"
    ;;
  resume-defense-budget-promotion-side-effects-v1)
    shift
    compose_database_url
    echo "Running resume-defense-budget-promotion-side-effects-v1 (writes only this scope's drain-pause row; dry run unless --commit)"
    exec ./node_modules/.bin/tsx scripts/resume-defense-budget-promotion-side-effects-v1.ts "$@"
    ;;
  *)
    exec /bin/sh /usr/local/lib/capiro/entrypoint-legacy.sh "$@"
    ;;
esac
