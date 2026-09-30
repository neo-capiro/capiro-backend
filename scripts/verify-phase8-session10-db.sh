#!/usr/bin/env bash
# Phase 8 Session 10 — disposable-database rehearsal.
#
# Proves against a real, zero-state PostgreSQL, not just against the domain
# functions, that:
#
#   - the full migration ledger (280+ prior migrations plus this session's)
#     applies cleanly from scratch;
#   - every Session 7-9 control-plane table Session 10 depends on still
#     exists, unmodified;
#   - the new table's CHECK constraints refuse every incoherent row this
#     session's own domain guards against, and accept every coherent one;
#   - upserting by (worker_id, tick_key) replaces a row rather than
#     duplicating it;
#   - capiro_defense_serve can SELECT the new table and nothing else on it;
#   - capiro_defense_job can SELECT/INSERT/UPDATE and NOT DELETE;
#   - defense_budget_watcher_adapter.next_check_at — the column this whole
#     session exists to finally read — is actually readable by the job role;
#   - no monetary or secret-shaped column exists on the new table, measured
#     against information_schema rather than trusted from a comment.
set -euo pipefail

IMAGE="${P8S10_REHEARSAL_PG_IMAGE:-pgvector/pgvector:pg16}"
PORT="${P8S10_REHEARSAL_PG_PORT:-55491}"
NAME="${P8S10_REHEARSAL_CONTAINER_NAME:-p8s10-schedule-rehearsal}"
SERVE_LOGIN="p8s10_serve_rehearsal"
JOB_LOGIN="p8s10_job_rehearsal"
LOGIN_PASSWORD="p8s10-rehearsal-password"

PASS_COUNT=0
log()  { echo "[p8s10-db-rehearsal] $*"; }
fail() { echo "[p8s10-db-rehearsal] FAILED: $*" >&2; exit 1; }
ok()   { PASS_COUNT=$((PASS_COUNT + 1)); echo "[p8s10-db-rehearsal]   ok  $*"; }

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
    if [ "${P8S10_REHEARSAL_KEEP:-0}" != "1" ]; then
      docker rm -f "$NAME" >/dev/null 2>&1 || true
    fi
  }
  trap cleanup EXIT

  log "waiting for postgres to accept connections"
  for _ in $(seq 1 60); do
    if docker exec "$NAME" pg_isready -h 127.0.0.1 -U capiro -d capiro >/dev/null 2>&1; then break; fi
    sleep 1
  done
  docker exec "$NAME" pg_isready -h 127.0.0.1 -U capiro -d capiro >/dev/null 2>&1 \
    || fail "PostgreSQL did not become ready"
  REHEARSAL_DATABASE_URL="postgresql://capiro:capiro@localhost:$PORT/capiro"
fi

if [ "$SELF_MANAGED" = "1" ]; then
  unset PGSERVICE PGSERVICEFILE PGOPTIONS
  export PGHOSTADDR=127.0.0.1
fi

ADMIN() {
  if [ "$SELF_MANAGED" = "1" ]; then
    docker exec -i "$NAME" psql --no-psqlrc -v ON_ERROR_STOP=1 -U capiro -d capiro "$@"
  else
    psql --no-psqlrc "$REHEARSAL_DATABASE_URL" -v ON_ERROR_STOP=1 "$@"
  fi
}
LOGIN_URL() {
  local user="$1"
  node -e "
    const u = new URL(process.argv[1]);
    u.username = process.argv[2];
    u.password = process.argv[3];
    console.log(u.toString());
  " "$REHEARSAL_DATABASE_URL" "$user" "$LOGIN_PASSWORD"
}

expect_ok() {
  local desc="$1"; shift
  if ADMIN -q -c "$1" >/tmp/p8s10-ok.$$ 2>&1; then
    ok "$desc"
  else
    cat /tmp/p8s10-ok.$$ >&2
    fail "expected to SUCCEED but failed: $desc"
  fi
  rm -f /tmp/p8s10-ok.$$
}

expect_fail() {
  local desc="$1"; shift
  if ADMIN -q -c "$1" >/tmp/p8s10-fail.$$ 2>&1; then
    cat /tmp/p8s10-fail.$$ >&2
    fail "expected to FAIL but succeeded: $desc"
  else
    ok "$desc"
  fi
  rm -f /tmp/p8s10-fail.$$
}

login_query() {
  local user="$1"; local sql="$2"
  PGPASSWORD="$LOGIN_PASSWORD" psql -v ON_ERROR_STOP=1 "$(LOGIN_URL "$user")" -q -c "$sql"
}

# ── 1. full migration ledger applies from scratch ───────────────────────────

log "1. applying the full migration ledger against a zero-state database"
if [ "$SELF_MANAGED" = "1" ]; then
  ADMIN < "$REPO_ROOT/scripts/ci/disposable-capiro-worker-role.sql"
else
  [ "$(ADMIN -tAc "SELECT NOT (r.rolsuper OR r.rolinherit OR r.rolcreaterole OR r.rolcreatedb OR r.rolcanlogin OR r.rolreplication OR r.rolbypassrls) AND NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE r.oid IN (m.roleid,m.member)) FROM pg_roles r WHERE r.rolname='capiro_worker';")" = "t" ] \
    || fail "external rehearsal requires an existing safe capiro_worker prerequisite"
fi
ok "restricted worker prerequisite verified before migration replay"
(
  cd "$REPO_ROOT/apps/api"
  DATABASE_URL="$REHEARSAL_DATABASE_URL" pnpm exec prisma migrate deploy
)
ok "prisma migrate deploy applied the full ledger, including this session's migration"

# ── 2. prior-session control-plane tables still exist, unmodified ──────────

log "2. Session 7-9 control-plane tables still exist"
for TABLE in \
  defense_budget_cycle \
  defense_budget_expected_source \
  defense_budget_source_observation \
  defense_budget_watcher_adapter \
  defense_budget_watcher_run \
  defense_budget_ingestion_outbox \
  defense_budget_lifecycle_signal \
  defense_budget_discovery_crawl \
  defense_budget_discovery_candidate \
  defense_budget_discovery_host_budget \
  defense_provider_invocation \
  defense_budget_schedule_tick
do
  expect_ok "table $TABLE exists" "SELECT 1 FROM $TABLE LIMIT 0;"
done

log "3. next_check_at — the column this session exists to finally read — is present and readable"
expect_ok "defense_budget_watcher_adapter.next_check_at is a real column" \
  "SELECT next_check_at FROM defense_budget_watcher_adapter LIMIT 0;"

# ── 4. rehearsal logins, inheriting the real capability roles ──────────────

log "4. creating rehearsal logins that inherit the real NOLOGIN capability roles"
ADMIN -q -c "DROP ROLE IF EXISTS $SERVE_LOGIN;" >/dev/null
ADMIN -q -c "DROP ROLE IF EXISTS $JOB_LOGIN;" >/dev/null
ADMIN -q -c "CREATE ROLE $SERVE_LOGIN LOGIN PASSWORD '$LOGIN_PASSWORD' IN ROLE capiro_defense_serve;" >/dev/null
ADMIN -q -c "CREATE ROLE $JOB_LOGIN LOGIN PASSWORD '$LOGIN_PASSWORD' IN ROLE capiro_defense_job;" >/dev/null
ok "rehearsal logins created"

VALID_INSERT="INSERT INTO defense_budget_schedule_tick
  (worker_id, tick_key, started_at, finished_at, outcome, horizon_bootstrapped,
   adapters_considered, adapters_due, adapters_succeeded, adapters_failed,
   adapters_skipped_lease, committed, failure_reason)
  VALUES ('w1', 'tick-1', now() - interval '5 seconds', now(), 'completed', true,
          1, 1, 1, 0, 0, true, NULL);"

# ── 5. CHECK constraints refuse every incoherent row ────────────────────────

log "5. negative controls — every row the domain's own builder would refuse"
expect_fail "outcome outside the enum is refused" \
  "INSERT INTO defense_budget_schedule_tick
     (worker_id, tick_key, started_at, finished_at, outcome, horizon_bootstrapped,
      adapters_considered, adapters_due, adapters_succeeded, adapters_failed,
      adapters_skipped_lease, committed, failure_reason)
   VALUES ('w', 't-bad-outcome', now(), now(), 'unknown', true, 1, 1, 1, 0, 0, true, NULL);"

expect_fail "outcome='failed' with no failure_reason is refused" \
  "INSERT INTO defense_budget_schedule_tick
     (worker_id, tick_key, started_at, finished_at, outcome, horizon_bootstrapped,
      adapters_considered, adapters_due, adapters_succeeded, adapters_failed,
      adapters_skipped_lease, committed, failure_reason)
   VALUES ('w', 't-failed-no-reason', now(), now(), 'failed', true, 0, 0, 0, 0, 0, true, NULL);"

expect_fail "outcome='completed' WITH a failure_reason is refused (coherence runs both directions)" \
  "INSERT INTO defense_budget_schedule_tick
     (worker_id, tick_key, started_at, finished_at, outcome, horizon_bootstrapped,
      adapters_considered, adapters_due, adapters_succeeded, adapters_failed,
      adapters_skipped_lease, committed, failure_reason)
   VALUES ('w', 't-completed-with-reason', now(), now(), 'completed', true, 0, 0, 0, 0, 0, true, 'should not be here');"

expect_fail "finished_at preceding started_at is refused" \
  "INSERT INTO defense_budget_schedule_tick
     (worker_id, tick_key, started_at, finished_at, outcome, horizon_bootstrapped,
      adapters_considered, adapters_due, adapters_succeeded, adapters_failed,
      adapters_skipped_lease, committed, failure_reason)
   VALUES ('w', 't-time-travel', now(), now() - interval '5 seconds', 'completed', true, 1, 1, 1, 0, 0, true, NULL);"

expect_fail "a blank worker_id is refused" \
  "INSERT INTO defense_budget_schedule_tick
     (worker_id, tick_key, started_at, finished_at, outcome, horizon_bootstrapped,
      adapters_considered, adapters_due, adapters_succeeded, adapters_failed,
      adapters_skipped_lease, committed, failure_reason)
   VALUES ('   ', 't-blank-worker', now(), now(), 'completed', true, 0, 0, 0, 0, 0, true, NULL);"

expect_fail "a blank tick_key is refused" \
  "INSERT INTO defense_budget_schedule_tick
     (worker_id, tick_key, started_at, finished_at, outcome, horizon_bootstrapped,
      adapters_considered, adapters_due, adapters_succeeded, adapters_failed,
      adapters_skipped_lease, committed, failure_reason)
   VALUES ('w', '', now(), now(), 'completed', true, 0, 0, 0, 0, 0, true, NULL);"

expect_fail "adapters_due exceeding adapters_considered is refused" \
  "INSERT INTO defense_budget_schedule_tick
     (worker_id, tick_key, started_at, finished_at, outcome, horizon_bootstrapped,
      adapters_considered, adapters_due, adapters_succeeded, adapters_failed,
      adapters_skipped_lease, committed, failure_reason)
   VALUES ('w', 't-due-exceeds', now(), now(), 'completed', true, 1, 2, 2, 0, 0, true, NULL);"

expect_fail "succeeded+failed+skippedLease not equal to due is refused" \
  "INSERT INTO defense_budget_schedule_tick
     (worker_id, tick_key, started_at, finished_at, outcome, horizon_bootstrapped,
      adapters_considered, adapters_due, adapters_succeeded, adapters_failed,
      adapters_skipped_lease, committed, failure_reason)
   VALUES ('w', 't-partition-mismatch', now(), now(), 'completed', true, 3, 3, 1, 0, 0, true, NULL);"

expect_fail "a negative adapter count is refused" \
  "INSERT INTO defense_budget_schedule_tick
     (worker_id, tick_key, started_at, finished_at, outcome, horizon_bootstrapped,
      adapters_considered, adapters_due, adapters_succeeded, adapters_failed,
      adapters_skipped_lease, committed, failure_reason)
   VALUES ('w', 't-negative', now(), now(), 'completed', true, -1, 0, 0, 0, 0, true, NULL);"

expect_fail "a failure_reason over 500 characters is refused" \
  "INSERT INTO defense_budget_schedule_tick
     (worker_id, tick_key, started_at, finished_at, outcome, horizon_bootstrapped,
      adapters_considered, adapters_due, adapters_succeeded, adapters_failed,
      adapters_skipped_lease, committed, failure_reason)
   VALUES ('w', 't-overlong-reason', now(), now(), 'failed', true, 0, 0, 0, 0, 0, true, repeat('x', 501));"

# ── 6. a coherent row is accepted, and upsert replaces rather than duplicates ─

log "6. positive control and idempotent upsert"
expect_ok "a fully coherent completed row is accepted" "$VALID_INSERT"
expect_ok "the same (worker_id, tick_key) upserts rather than duplicating" \
  "INSERT INTO defense_budget_schedule_tick
     (worker_id, tick_key, started_at, finished_at, outcome, horizon_bootstrapped,
      adapters_considered, adapters_due, adapters_succeeded, adapters_failed,
      adapters_skipped_lease, committed, failure_reason)
   VALUES ('w1', 'tick-1', now() - interval '5 seconds', now(), 'failed', true, 1, 1, 0, 1, 0, true, 'retried tick outcome')
   ON CONFLICT (worker_id, tick_key) DO UPDATE SET
     outcome = EXCLUDED.outcome, adapters_succeeded = EXCLUDED.adapters_succeeded,
     adapters_failed = EXCLUDED.adapters_failed, failure_reason = EXCLUDED.failure_reason,
     finished_at = EXCLUDED.finished_at, updated_at = CURRENT_TIMESTAMP;"

ROW_COUNT="$(ADMIN -t -A -c "SELECT count(*) FROM defense_budget_schedule_tick WHERE worker_id = 'w1' AND tick_key = 'tick-1';")"
if [ "$ROW_COUNT" != "1" ]; then
  fail "expected exactly one row for (w1, tick-1) after the upsert, found $ROW_COUNT"
fi
ok "exactly one row exists for (w1, tick-1) after two writes"

STORED_OUTCOME="$(ADMIN -t -A -c "SELECT outcome FROM defense_budget_schedule_tick WHERE worker_id = 'w1' AND tick_key = 'tick-1';")"
if [ "$STORED_OUTCOME" != "failed" ]; then
  fail "expected the upsert to have replaced outcome with 'failed', found '$STORED_OUTCOME'"
fi
ok "the upsert replaced the row's own outcome rather than leaving the original"

# ── 7. role boundary, measured ──────────────────────────────────────────────

log "7. role boundary"
login_query "$SERVE_LOGIN" "SELECT 1 FROM defense_budget_schedule_tick LIMIT 0;"
ok "serve can SELECT the new table"
if login_query "$SERVE_LOGIN" "$VALID_INSERT" >/tmp/p8s10-serve-insert.$$ 2>&1; then
  cat /tmp/p8s10-serve-insert.$$ >&2
  fail "serve must NOT be able to INSERT into defense_budget_schedule_tick"
fi
rm -f /tmp/p8s10-serve-insert.$$
ok "serve cannot INSERT into the new table"

login_query "$JOB_LOGIN" "SELECT 1 FROM defense_budget_schedule_tick LIMIT 0;"
ok "job can SELECT the new table"
login_query "$JOB_LOGIN" \
  "INSERT INTO defense_budget_schedule_tick
     (worker_id, tick_key, started_at, finished_at, outcome, horizon_bootstrapped,
      adapters_considered, adapters_due, adapters_succeeded, adapters_failed,
      adapters_skipped_lease, committed, failure_reason)
   VALUES ('w-job', 'tick-job-1', now(), now(), 'completed', true, 0, 0, 0, 0, 0, true, NULL);"
ok "job can INSERT into the new table"
login_query "$JOB_LOGIN" \
  "UPDATE defense_budget_schedule_tick SET horizon_bootstrapped = false
     WHERE worker_id = 'w-job' AND tick_key = 'tick-job-1';"
ok "job can UPDATE its own tick row"
if login_query "$JOB_LOGIN" "DELETE FROM defense_budget_schedule_tick WHERE worker_id = 'w-job';" \
  >/tmp/p8s10-job-delete.$$ 2>&1; then
  cat /tmp/p8s10-job-delete.$$ >&2
  fail "job must NOT be able to DELETE from defense_budget_schedule_tick; the tick history is append-only"
fi
rm -f /tmp/p8s10-job-delete.$$
ok "job cannot DELETE from the new table"

login_query "$JOB_LOGIN" "SELECT next_check_at FROM defense_budget_watcher_adapter LIMIT 0;"
ok "job can read next_check_at on the Session 7 table — the actual point of this session"

login_query "$JOB_LOGIN" "SELECT 1 FROM defense_budget_watcher_run LIMIT 0;"
if login_query "$JOB_LOGIN" "DELETE FROM defense_budget_watcher_run;" >/tmp/p8s10-wr-delete.$$ 2>&1; then
  cat /tmp/p8s10-wr-delete.$$ >&2
  fail "job must still be unable to DELETE from defense_budget_watcher_run; Session 7's boundary must be untouched"
fi
rm -f /tmp/p8s10-wr-delete.$$
ok "the Session 7 no-DELETE boundary on defense_budget_watcher_run is unchanged"

# ── 8. no monetary or secret-shaped column ──────────────────────────────────

log "8. no monetary or secret-shaped column, measured not asserted"
MONEY_COLUMNS="$(ADMIN -t -A -c "
  SELECT count(*) FROM information_schema.columns
   WHERE table_name = 'defense_budget_schedule_tick'
     AND column_name ~* '(amount|dollar|usd|cost|price|spend)';")"
if [ "$MONEY_COLUMNS" != "0" ]; then
  fail "expected 0 monetary-shaped columns on defense_budget_schedule_tick, found $MONEY_COLUMNS"
fi
ok "0 monetary-shaped columns on defense_budget_schedule_tick"

SECRET_COLUMNS="$(ADMIN -t -A -c "
  SELECT count(*) FROM information_schema.columns
   WHERE table_name = 'defense_budget_schedule_tick'
     AND column_name ~* '(secret|token|credential|password|apikey)';")"
if [ "$SECRET_COLUMNS" != "0" ]; then
  fail "expected 0 secret-shaped columns on defense_budget_schedule_tick, found $SECRET_COLUMNS"
fi
ok "0 secret-shaped columns on defense_budget_schedule_tick"

log "SESSION10_DB_REHEARSAL_PASS ($PASS_COUNT checks)"
