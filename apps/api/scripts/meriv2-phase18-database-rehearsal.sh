#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
cd "$ROOT"

EVIDENCE_DIR="${PHASE18_EVIDENCE_DIR:-/tmp/meriv2-phase18-evidence}"
CONTAINER_NAME="${PHASE18_PG_NAME:-meriv2-phase18-pg}"
PORT="${PHASE18_PG_PORT:-55448}"
mkdir -p "$EVIDENCE_DIR"
rm -f "$EVIDENCE_DIR"/*.log "$EVIDENCE_DIR"/*.json 2>/dev/null || true

if ! command -v docker >/dev/null 2>&1; then
  echo "FATAL: docker is required for disposable pgvector PostgreSQL" >&2
  exit 1
fi
if ! command -v psql >/dev/null 2>&1; then
  echo "FATAL: psql is required for the actual application-role rehearsal" >&2
  exit 1
fi

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

export PE_PHASE_9_PG_NAME="$CONTAINER_NAME"
export PE_PHASE_9_PG_PORT="$PORT"
export PE_PHASE_9_EXPECT_BRANCH_MIGS=14
export PE_PHASE_9_STRICT_PE_MIG_NAMES=0
export PE_PHASE_9_KEEP=1

# Reuse the repository's established PostgreSQL 16 + pgvector clean/upgrade
# replay harness. It applies every migration to a clean DB, constructs a
# main-equivalent upgrade DB, dump/restores that snapshot, applies branch-only
# migrations, and requires the two final migration-name sets to match.
bash apps/api/scripts/pe-phase-9-migration-replay.sh \
  > >(tee "$EVIDENCE_DIR/00-migration-replay.log") \
  2> >(tee "$EVIDENCE_DIR/00-migration-replay.err.log" >&2)

CLEAN_URL="postgresql://capiro:capiro@127.0.0.1:${PORT}/capiro?schema=public"
CLEAN_PSQL="postgresql://capiro:capiro@127.0.0.1:${PORT}/capiro"
UPGRADE_URL="postgresql://capiro:capiro@127.0.0.1:${PORT}/pe_phase9_upgrade?schema=public"
UPGRADE_PSQL="postgresql://capiro:capiro@127.0.0.1:${PORT}/pe_phase9_upgrade"
APP_URL="postgresql://capiro_app:placeholder-rotate-via-bootstrap-roles@127.0.0.1:${PORT}/capiro"

FAILURES=0
run_gate() {
  local name="$1"; shift
  local log="$EVIDENCE_DIR/${name}.log"
  echo "== gate: $name =="
  set +e
  "$@" > >(tee "$log") 2> >(tee "$EVIDENCE_DIR/${name}.err.log" >&2)
  local code=$?
  set -e
  printf '{"gate":"%s","exitCode":%d}\n' "$name" "$code" > "$EVIDENCE_DIR/${name}.json"
  if [[ $code -ne 0 ]]; then
    FAILURES=$((FAILURES + 1))
    echo "GATE_FAILED name=$name exit=$code" >&2
  else
    echo "GATE_PASSED name=$name"
  fi
}

run_db_gates() {
  local label="$1" prisma_url="$2" psql_url="$3"
  run_gate "${label}-prisma-validate" env DATABASE_URL="$prisma_url" \
    pnpm --filter @capiro/api exec prisma validate
  run_gate "${label}-migrate-status" env DATABASE_URL="$prisma_url" \
    pnpm --filter @capiro/api exec prisma migrate status
  run_gate "${label}-schema-assertions" psql "$psql_url" -v ON_ERROR_STOP=1 \
    -f apps/api/scripts/meriv2-phase18-schema-assertions.sql
  run_gate "${label}-schema-drift" env DATABASE_URL="$prisma_url" \
    pnpm --filter @capiro/api exec prisma migrate diff \
      --from-url "$prisma_url" \
      --to-schema-datamodel prisma/schema.prisma \
      --exit-code
  run_gate "${label}-application-lifecycle" env DATABASE_URL="$prisma_url" \
    pnpm --filter @capiro/api exec tsx scripts/meriv2-phase18-application-rehearsal.ts
  run_gate "${label}-backfill-idempotency" env DATABASE_URL="$prisma_url" \
    pnpm --filter @capiro/api exec tsx scripts/meriv2-phase18-backfill-rehearsal.ts
  run_gate "${label}-backfill-drift-rollback" env \
    DATABASE_URL="$prisma_url" PSQL_DATABASE_URL="$psql_url" \
    bash apps/api/scripts/test-memory-governance-backfill-rollback.sh
  run_gate "${label}-policy-pack-lifecycle" env \
    DATABASE_URL="$prisma_url" PSQL_DATABASE_URL="$psql_url" \
    bash apps/api/scripts/test-policy-pack-lifecycle-concurrency.sh
}

run_db_gates clean "$CLEAN_URL" "$CLEAN_PSQL"
run_db_gates upgrade "$UPGRADE_URL" "$UPGRADE_PSQL"

# The app-role migration grants CONNECT to the production-named `capiro` DB.
# Exercise that exact role/DB pair rather than granting broader test privileges.
run_gate "clean-application-role-rls" env \
  PSQL_DATABASE_URL="$CLEAN_PSQL" PHASE18_APP_DATABASE_URL="$APP_URL" \
  bash apps/api/scripts/meriv2-phase18-rls-rehearsal.sh

psql "$CLEAN_PSQL" -qAt -c "
  SELECT json_build_object(
    'database', current_database(),
    'serverVersion', current_setting('server_version'),
    'vectorVersion', (SELECT extversion FROM pg_extension WHERE extname='vector'),
    'appliedMigrations', (SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL)
  );" > "$EVIDENCE_DIR/clean-database-version.json"
psql "$UPGRADE_PSQL" -qAt -c "
  SELECT json_build_object(
    'database', current_database(),
    'serverVersion', current_setting('server_version'),
    'vectorVersion', (SELECT extversion FROM pg_extension WHERE extname='vector'),
    'appliedMigrations', (SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL)
  );" > "$EVIDENCE_DIR/upgrade-database-version.json"

printf '{"marker":"MERIV2_PHASE18_DATABASE_REHEARSAL_SUMMARY","failures":%d,"cleanDatabase":"capiro","upgradeDatabase":"pe_phase9_upgrade"}\n' \
  "$FAILURES" | tee "$EVIDENCE_DIR/summary.json"

if [[ $FAILURES -ne 0 ]]; then
  echo "MERIV2_PHASE18_DATABASE_REHEARSAL_FAILED failures=$FAILURES" >&2
  exit 1
fi

echo "MERIV2_PHASE18_DATABASE_REHEARSAL_OK"
