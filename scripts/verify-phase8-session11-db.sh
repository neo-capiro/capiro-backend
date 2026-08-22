#!/usr/bin/env bash
# Phase 8 Session 11 — disposable-database rehearsal.
#
# Proves against a real, zero-state PostgreSQL, not just against the domain
# functions or an in-memory fixture double:
#
#   - the full migration ledger applies cleanly from scratch (schema
#     untouched by Session 11 — this is the SAME ledger Session 10 rehearsed);
#   - capiro_defense_serve can perform every one of the six Session 11 read
#     routes, and CANNOT write to any table this session touches — the exact
#     grant boundary this session's whole read-only design rests on, measured
#     against a seeded, historically-grounded, two-fiscal-year corpus rather
#     than assumed;
#   - capiro_defense_job retains write access, unchanged;
#   - the REAL compiled BudgetLifecycleQueryService, running the REAL
#     PrismaBudgetLifecycleReadStore against this database, reports cycle
#     health, coverage, the review queue, signals and tick health that
#     reflect the seeded lifecycle truth — not merely that rows exist;
#   - the governed run-review-resolution.mjs CLI resolves a review_required
#     row end-to-end (list -> dry run -> serve-role commit REFUSED ->
#     job-role commit COMMITTED -> repeat REFUSED), changes exactly the
#     target row, writes exactly one defense_budget_review_resolution row,
#     and the very next read reflects the resolution with provenance intact.
set -euo pipefail

IMAGE="${P8S11_REHEARSAL_PG_IMAGE:-pgvector/pgvector:pg16}"
PORT="${P8S11_REHEARSAL_PG_PORT:-55492}"
NAME="${P8S11_REHEARSAL_CONTAINER_NAME:-p8s11-product-rehearsal}"
SERVE_LOGIN="p8s11_serve_rehearsal"
JOB_LOGIN="p8s11_job_rehearsal"
LOGIN_PASSWORD="p8s11-rehearsal-password"

log()  { echo "[p8s11-db-rehearsal] $*"; }
fail() { echo "[p8s11-db-rehearsal] FAILED: $*" >&2; exit 1; }

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
    if [ "${P8S11_REHEARSAL_KEEP:-0}" != "1" ]; then
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

log "1. applying the full migration ledger against a zero-state database"
(
  cd "$REPO_ROOT/apps/api"
  DATABASE_URL="$REHEARSAL_DATABASE_URL" pnpm exec prisma migrate deploy
)
log "prisma migrate deploy applied the full ledger (Session 11 adds no migration of its own)"

log "2. rehearsal login roles for Session 11 (serve + job)"
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

log "3. generating the defense-api Prisma client + build for the current platform"
(
  cd "$REPO_ROOT/apps/defense-api"
  pnpm exec prisma generate --schema prisma/schema.prisma
  # Same as the package.json "build" script: a composite tsconfig's stale
  # tsbuildinfo can make `nest build` (deleteOutDir:true) emit nothing at all
  # after the dist/ deletion, exit 0, and leave dist/ missing.
  rm -f tsconfig.tsbuildinfo
  pnpm exec nest build
)

log "4. seeding the Session 11 rehearsal corpus (two overlapping fiscal years, real corpus-derived text)"
DATABASE_URL="$REHEARSAL_DATABASE_URL" node "$REPO_ROOT/scripts/seed-phase8-session11-corpus.mjs"

log "5. running the real product/read integration + role-boundary + governed-resolution proof"
ADMIN_DATABASE_URL="$REHEARSAL_DATABASE_URL" \
SERVE_DATABASE_URL="$SERVE_URL" \
JOB_DATABASE_URL="$JOB_URL" \
  node "$REPO_ROOT/scripts/verify-phase8-session11-integration.mjs"

log "SESSION11_DB_REHEARSAL_PASS"
