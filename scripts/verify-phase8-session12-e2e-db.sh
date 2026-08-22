#!/usr/bin/env bash
# Phase 8 Session 12 — end-to-end closeout disposable-database rehearsal.
#
# Same precedent as every prior Phase 8 session's own -db.sh: a self-managed
# pgvector/pgvector:pg16 container, the full current migration ledger applied
# from scratch (Session 12 adds no migration of its own — see the closeout
# handoff for why none was needed), rehearsal LOGIN roles that inherit the
# real capiro_defense_serve/capiro_defense_job NOLOGIN roles, the REAL
# defense-api build, and then:
#
#   1. scripts/seed-phase8-session12-corpus.mjs — drives the REAL Session 7
#      control loop (AnnualDefenseBudgetCycleController +
#      DefenseBudgetLifecycleWatcher) through fixture ports (no network) to
#      build a genuinely behavioral, two-fiscal-year corpus: dedup, an
#      immutable version supersession, a real ambiguous-omnibus
#      review_required case, a CR overlay, a separately-attributable
#      supplemental, and a simulated adapter outage isolated to one FY/track.
#   2. scripts/verify-phase8-session12-e2e.mjs — the real product/read
#      integration + role-boundary + governed-resolution + poison-isolation
#      proof, run against the REAL compiled BudgetLifecycleQueryService.
#
# This script performs NO AWS call, NO EventBridge/cron registration, sets
# NO PHASE8_SESSION10_TICK_AUTHORIZED anywhere, and makes NO live network
# request to any government site — everything above runs against fixture
# data and a disposable local Postgres only.
set -euo pipefail

IMAGE="${P8S12_REHEARSAL_PG_IMAGE:-pgvector/pgvector:pg16}"
PORT="${P8S12_REHEARSAL_PG_PORT:-55493}"
NAME="${P8S12_REHEARSAL_CONTAINER_NAME:-p8s12-e2e-rehearsal}"
SERVE_LOGIN="p8s12_serve_rehearsal"
JOB_LOGIN="p8s12_job_rehearsal"
LOGIN_PASSWORD="p8s12-rehearsal-password"

log()  { echo "[p8s12-e2e-db-rehearsal] $*"; }
fail() { echo "[p8s12-e2e-db-rehearsal] FAILED: $*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SELF_MANAGED=0
if [ -z "${REHEARSAL_DATABASE_URL:-}" ]; then
  SELF_MANAGED=1
  log "no REHEARSAL_DATABASE_URL supplied; managing a disposable $IMAGE container on port $PORT"
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" \
    -e POSTGRES_USER=capiro -e POSTGRES_PASSWORD=capiro -e POSTGRES_DB=capiro \
    -p "$PORT:5432" "$IMAGE" >/dev/null
  cleanup() {
    if [ "${P8S12_REHEARSAL_KEEP:-0}" != "1" ]; then
      docker rm -f "$NAME" >/dev/null 2>&1 || true
    fi
  }
  trap cleanup EXIT

  log "waiting for postgres to accept connections"
  for _ in $(seq 1 60); do
    if docker exec "$NAME" pg_isready -U capiro -d capiro >/dev/null 2>&1; then break; fi
    sleep 1
  done
  REHEARSAL_DATABASE_URL="postgresql://capiro:capiro@localhost:$PORT/capiro"
fi

ADMIN() {
  if [ "$SELF_MANAGED" = "1" ]; then
    docker exec -i "$NAME" psql -v ON_ERROR_STOP=1 -U capiro -d capiro "$@"
  else
    PGPASSWORD="${REHEARSAL_ADMIN_PASSWORD:-capiro}" psql -v ON_ERROR_STOP=1 "$REHEARSAL_DATABASE_URL" "$@"
  fi
}

log "1. applying the full current migration ledger against a zero-state database"
(
  cd "$REPO_ROOT/apps/api"
  DATABASE_URL="$REHEARSAL_DATABASE_URL" pnpm exec prisma migrate deploy
)
log "prisma migrate deploy applied the full ledger (Session 12 adds no migration of its own)"

log "2. rehearsal login roles for Session 12 (serve + job)"
ADMIN -q -c "DROP ROLE IF EXISTS $SERVE_LOGIN;" >/dev/null
ADMIN -q -c "DROP ROLE IF EXISTS $JOB_LOGIN;" >/dev/null
ADMIN -q -c "CREATE ROLE $SERVE_LOGIN LOGIN PASSWORD '$LOGIN_PASSWORD' IN ROLE capiro_defense_serve;" >/dev/null
ADMIN -q -c "CREATE ROLE $JOB_LOGIN LOGIN PASSWORD '$LOGIN_PASSWORD' IN ROLE capiro_defense_job;" >/dev/null

SERVE_URL="$(node -e "
  const u = new URL(process.argv[1]);
  u.username = '$SERVE_LOGIN'; u.password = '$LOGIN_PASSWORD';
  console.log(u.toString());
" "$REHEARSAL_DATABASE_URL")"
JOB_URL="$(node -e "
  const u = new URL(process.argv[1]);
  u.username = '$JOB_LOGIN'; u.password = '$LOGIN_PASSWORD';
  console.log(u.toString());
" "$REHEARSAL_DATABASE_URL")"

log "3a. building defense-api's own workspace dependencies first (@capiro/auth, defense-domain, defense-contracts, ...)"
(
  cd "$REPO_ROOT"
  # A fresh clone/install has no packages/*/dist yet, so `nest build`'s
  # TS module resolution against workspace packages fails outright (measured:
  # 64 TS2307 "cannot find module" errors against @capiro/auth,
  # @capiro/defense-contracts and @capiro/defense-domain/pe-read on the first
  # attempt). turbo's dependency graph (`dependsOn: ["^build"]`) builds every
  # workspace dependency defense-api needs, in the correct order, without
  # building defense-api itself here (kept explicit below so the tsbuildinfo
  # removal stays visible).
  pnpm turbo run build --filter='@capiro/defense-api^...'
)

log "3b. generating the defense-api Prisma client + build for the current platform"
(
  cd "$REPO_ROOT/apps/defense-api"
  pnpm exec prisma generate --schema prisma/schema.prisma
  # Same as the package.json "build" script: a composite tsconfig's stale
  # tsbuildinfo can make `nest build` (deleteOutDir:true) emit nothing at all
  # after the dist/ deletion, exit 0, and leave dist/ missing (a real Session
  # 11 rehearsal bug, fixed by always removing it first).
  rm -f tsconfig.tsbuildinfo
  pnpm exec nest build
)

log "4. seeding the Session 12 rehearsal corpus by running the REAL control loop against fixtures (no network)"
DATABASE_URL="$REHEARSAL_DATABASE_URL" node "$REPO_ROOT/scripts/seed-phase8-session12-corpus.mjs"

log "5. running the real end-to-end product/read + role-boundary + governed-resolution + poison-isolation proof"
ADMIN_DATABASE_URL="$REHEARSAL_DATABASE_URL" \
SERVE_DATABASE_URL="$SERVE_URL" \
JOB_DATABASE_URL="$JOB_URL" \
  node "$REPO_ROOT/scripts/verify-phase8-session12-e2e.mjs"

log "SESSION12_E2E_DB_REHEARSAL_PASS"
