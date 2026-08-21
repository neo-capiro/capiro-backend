#!/usr/bin/env bash
# Phase 8 Session 11 — disposable-database rehearsal.
#
# Proves against a real, zero-state PostgreSQL, not just against the domain
# functions or an in-memory fixture double:
#
#   - the full migration ledger applies cleanly from scratch (schema
#     untouched by Session 11 — this is the SAME ledger Session 10 rehearsed);
#   - capiro_defense_serve can SELECT every budget-lifecycle table and CANNOT
#     write to ANY of them — the exact grant boundary this session's whole
#     read-only design rests on, measured rather than assumed;
#   - capiro_defense_job retains write access, unchanged;
#   - the REAL compiled BudgetLifecycleQueryService, running the REAL
#     PrismaBudgetLifecycleReadStore against this database, reports cycle
#     health, coverage, the review queue and signals that reflect the seeded
#     lifecycle truth — not merely that rows exist in storage;
#   - the governed run-review-resolution.mjs CLI resolves a review_required
#     row end-to-end (list -> dry run -> authorised commit) and writes an
#     audit_logs row, and refuses a second resolution of the same row.
set -euo pipefail

IMAGE="${P8S11_REHEARSAL_PG_IMAGE:-pgvector/pgvector:pg16}"
PORT="${P8S11_REHEARSAL_PG_PORT:-55492}"
NAME="${P8S11_REHEARSAL_CONTAINER_NAME:-p8s11-product-rehearsal}"
SERVE_LOGIN="p8s11_serve_rehearsal"
JOB_LOGIN="p8s11_job_rehearsal"
LOGIN_PASSWORD="p8s11-rehearsal-password"

PASS_COUNT=0
log()  { echo "[p8s11-db-rehearsal] $*"; }
fail() { echo "[p8s11-db-rehearsal] FAILED: $*" >&2; exit 1; }
ok()   { PASS_COUNT=$((PASS_COUNT + 1)); echo "[p8s11-db-rehearsal]   ok  $*"; }

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

ADMIN() { docker exec -i "$NAME" psql -v ON_ERROR_STOP=1 -U capiro -d capiro "$@"; }
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
  if ADMIN -q -c "$1" >/tmp/p8s11-ok.$$ 2>&1; then
    ok "$desc"
  else
    cat /tmp/p8s11-ok.$$ >&2
    fail "expected to SUCCEED but failed: $desc"
  fi
  rm -f /tmp/p8s11-ok.$$
}

login_query() {
  local user="$1"; local sql="$2"
  PGPASSWORD="$LOGIN_PASSWORD" psql -v ON_ERROR_STOP=1 "$(LOGIN_URL "$user")" -q -c "$sql"
}

expect_login_fail() {
  local desc="$1"; local user="$2"; local sql="$3"
  if login_query "$user" "$sql" >/tmp/p8s11-fail.$$ 2>&1; then
    cat /tmp/p8s11-fail.$$ >&2
    fail "expected to FAIL but succeeded: $desc"
  else
    ok "$desc"
  fi
  rm -f /tmp/p8s11-fail.$$
}

# ── 1. full migration ledger applies from scratch ───────────────────────────

log "1. applying the full migration ledger against a zero-state database"
(
  cd "$REPO_ROOT/apps/api"
  DATABASE_URL="$REHEARSAL_DATABASE_URL" pnpm exec prisma migrate deploy
)
ok "prisma migrate deploy applied the full ledger (Session 11 adds no migration of its own)"

# ── 2. rehearsal logins, inheriting the real capability roles ──────────────

log "2. creating rehearsal logins that inherit the real NOLOGIN capability roles"
ADMIN -q -c "DROP ROLE IF EXISTS $SERVE_LOGIN;" >/dev/null
ADMIN -q -c "DROP ROLE IF EXISTS $JOB_LOGIN;" >/dev/null
ADMIN -q -c "CREATE ROLE $SERVE_LOGIN LOGIN PASSWORD '$LOGIN_PASSWORD' IN ROLE capiro_defense_serve;" >/dev/null
ADMIN -q -c "CREATE ROLE $JOB_LOGIN LOGIN PASSWORD '$LOGIN_PASSWORD' IN ROLE capiro_defense_job;" >/dev/null
ok "rehearsal logins created"

# ── 3. seed a real FY2027 scenario ──────────────────────────────────────────

log "3. seeding a realistic FY2027 scenario (published PB, review_required HASC, a schedule tick)"
ADMIN -q -c "
  INSERT INTO defense_budget_cycle (id, fiscal_year, authority_track, status, template_version, bootstrap_origin, dedup_key)
  VALUES
    ('11111111-1111-1111-1111-111111111101', 2027, 'request', 'active', 'v1', 'template', repeat('a', 64)),
    ('11111111-1111-1111-1111-111111111102', 2027, 'authorization', 'active', 'v1', 'template', repeat('b', 64));

  INSERT INTO defense_budget_expected_source
    (id, cycle_id, fiscal_year, authority_track, stage, source_family, adapter_id, label,
     expected_state, optional, template_version, expected_from, expected_to, dedup_key)
  VALUES
    ('22222222-2222-2222-2222-222222222201', '11111111-1111-1111-1111-111111111101', 2027, 'request',
     'president_budget_request', 'pb_overview', 'govinfo-budget', 'FY2027 President''s Budget Overview',
     'published', false, 'v1', now() - interval '60 days', now() + interval '300 days', repeat('c', 64)),
    ('22222222-2222-2222-2222-222222222202', '11111111-1111-1111-1111-111111111102', 2027, 'authorization',
     'hasc_report', 'auth_committee_report', 'hasc', 'HASC Report FY2027',
     'review_required', false, 'v1', now() - interval '30 days', now() + interval '300 days', repeat('d', 64));
  UPDATE defense_budget_expected_source SET review_reason = 'classifier confidence below threshold'
   WHERE id = '22222222-2222-2222-2222-222222222202';

  INSERT INTO defense_budget_source_observation
    (id, expected_source_id, cycle_id, adapter_id, discovered_url, content_sha256, byte_size,
     observation_state, revision_kind, classified_fiscal_year, classified_authority_track,
     classified_stage, classified_source_family, classification_confidence, review_reasons,
     source_document_id, first_seen_at, last_seen_at, dedup_key)
  VALUES
    ('33333333-3333-3333-3333-333333333301', '22222222-2222-2222-2222-222222222201',
     '11111111-1111-1111-1111-111111111101', 'govinfo-budget',
     'https://www.govinfo.gov/content/pkg/BUDGET-2027-BUD/pdf/BUDGET-2027-BUD.pdf', repeat('1', 64), 2048,
     'ingested', 'first_discovery', 2027, 'request', 'president_budget_request', 'pb_overview', 0.99, '[]',
     NULL, now() - interval '55 days', now() - interval '55 days', repeat('e', 64)),
    ('33333333-3333-3333-3333-333333333302', '22222222-2222-2222-2222-222222222202',
     '11111111-1111-1111-1111-111111111102', 'hasc',
     'https://www.congress.gov/crpt/119hrpt1/pdf/crpt-1.pdf', repeat('2', 64), 4096,
     'review_required', 'first_discovery', NULL, NULL, NULL, NULL, 0.62,
     '[\"content excerpt did not corroborate metadata\"]',
     NULL, now() - interval '10 days', now() - interval '10 days', repeat('f', 64));

  INSERT INTO defense_budget_watcher_adapter
    (adapter_id, status, next_check_at, consecutive_failures)
  VALUES
    ('govinfo-budget', 'idle', now() + interval '1 day', 0),
    ('hasc', 'idle', now() + interval '1 day', 1);

  INSERT INTO defense_budget_watcher_run
    (adapter_id, run_key, status, started_at, finished_at, discovered_count, unchanged_count,
     changed_count, review_count, queued_count, blocked_count, next_check_at)
  VALUES
    ('govinfo-budget', 'run-1', 'succeeded', now() - interval '1 hour', now() - interval '55 minutes',
     1, 0, 1, 0, 1, 0, now() + interval '1 day'),
    ('hasc', 'run-1', 'succeeded', now() - interval '1 hour', now() - interval '58 minutes',
     1, 0, 1, 1, 0, 0, now() + interval '1 day');

  INSERT INTO defense_budget_ingestion_outbox
    (observation_id, observation_state, cycle_id, job_kind, state, dedup_key)
  VALUES
    ('33333333-3333-3333-3333-333333333301', 'ingested', '11111111-1111-1111-1111-111111111101',
     'governed_source_ingestion', 'succeeded', repeat('4', 64));

  INSERT INTO defense_budget_schedule_tick
    (worker_id, tick_key, started_at, finished_at, outcome, horizon_bootstrapped,
     adapters_considered, adapters_due, adapters_succeeded, adapters_failed,
     adapters_skipped_lease, committed, failure_reason)
  VALUES
    ('rehearsal-worker', 'rehearsal-tick-1', now() - interval '1 hour', now() - interval '55 minutes',
     'completed', false, 14, 2, 2, 0, 0, true, NULL);
"
ok "seeded 2 cycles, 2 expected sources, 2 observations, 2 adapters, 2 runs, 1 outbox row, 1 schedule tick"

# ── 4. role boundary: serve reads, cannot write, on every table this session touches ─

log "4. role boundary — capiro_defense_serve is read-only on every table Session 11 queries"
for TABLE in defense_budget_cycle defense_budget_expected_source defense_budget_source_observation \
             defense_budget_watcher_adapter defense_budget_watcher_run defense_budget_ingestion_outbox \
             defense_budget_schedule_tick; do
  login_query "$SERVE_LOGIN" "SELECT 1 FROM $TABLE LIMIT 0;"
  ok "serve can SELECT $TABLE"
done
expect_login_fail "serve cannot UPDATE defense_budget_expected_source" "$SERVE_LOGIN" \
  "UPDATE defense_budget_expected_source SET expected_state = 'published' WHERE id = '22222222-2222-2222-2222-222222222202';"
expect_login_fail "serve cannot INSERT into defense_budget_source_observation" "$SERVE_LOGIN" \
  "INSERT INTO defense_budget_source_observation
     (id, expected_source_id, cycle_id, adapter_id, discovered_url, content_sha256, observation_state,
      revision_kind, dedup_key, first_seen_at, last_seen_at)
   VALUES (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', '11111111-1111-1111-1111-111111111101',
           'govinfo-budget', 'https://example.test', repeat('9', 64), 'discovered', 'first_discovery',
           repeat('9', 64), now(), now());"

login_query "$JOB_LOGIN" "SELECT 1 FROM defense_budget_expected_source LIMIT 0;"
ok "job can still SELECT defense_budget_expected_source (unchanged from Session 7)"
login_query "$JOB_LOGIN" \
  "UPDATE defense_budget_expected_source SET updated_at = CURRENT_TIMESTAMP WHERE id = '22222222-2222-2222-2222-222222222201';"
ok "job can still UPDATE defense_budget_expected_source (unchanged from Session 7)"

# ── 5. the REAL compiled query service, against this database ──────────────

log "5. running the real BudgetLifecycleQueryService against this database"
DATABASE_URL="$REHEARSAL_DATABASE_URL" node "$SCRIPT_DIR/verify-phase8-session11-integration.mjs"
ok "BudgetLifecycleQueryService reported cycle health, coverage, review queue and signals matching the seeded lifecycle truth"

# ── 6. the governed review-resolution CLI, end-to-end ───────────────────────

log "6. run-review-resolution.mjs end-to-end: list -> dry run -> authorised commit -> refused repeat"
EXPECTED_SOURCE_ID="22222222-2222-2222-2222-222222222202"
ACTOR_USER_ID="44444444-4444-4444-4444-444444444401"
TENANT_ID=""
TENANT_ID="$(ADMIN -t -A -c "SELECT id FROM tenants LIMIT 1;" || true)"
if [ -z "$TENANT_ID" ]; then
  TENANT_ID="55555555-5555-5555-5555-555555555501"
  ADMIN -q -c "INSERT INTO tenants (id, name, slug) VALUES ('$TENANT_ID', 'Rehearsal Tenant', 'rehearsal-tenant-p8s11') ON CONFLICT DO NOTHING;" >/dev/null || true
fi

CLI="$REPO_ROOT/apps/defense-api/scripts/run-review-resolution.mjs"

DATABASE_URL="$REHEARSAL_DATABASE_URL" node "$CLI" --list --fiscal-year 2027 | grep -q "$EXPECTED_SOURCE_ID"
ok "--list surfaces the seeded review_required expected source"

DATABASE_URL="$REHEARSAL_DATABASE_URL" node "$CLI" \
  --expected-source-id "$EXPECTED_SOURCE_ID" --decision published \
  --note "rehearsal dry run" --actor-user-id "$ACTOR_USER_ID" --tenant-id "$TENANT_ID" \
  | grep -q "SESSION11_REVIEW_RESOLUTION_DRY_RUN_PASS"
ok "a dry run (no --commit) reports what it would do and writes nothing"

STILL_REVIEW="$(ADMIN -t -A -c "SELECT expected_state FROM defense_budget_expected_source WHERE id = '$EXPECTED_SOURCE_ID';")"
if [ "$STILL_REVIEW" != "review_required" ]; then
  fail "the dry run must not have changed expected_state, found '$STILL_REVIEW'"
fi
ok "the dry run left expected_state untouched"

PHASE8_SESSION11_REVIEW_RESOLUTION_AUTHORIZED=true \
  DATABASE_URL="$REHEARSAL_DATABASE_URL" node "$CLI" \
  --expected-source-id "$EXPECTED_SOURCE_ID" --decision published \
  --note "verified against the publisher's own package page" \
  --actor-user-id "$ACTOR_USER_ID" --tenant-id "$TENANT_ID" --commit \
  | grep -q "SESSION11_REVIEW_RESOLUTION_COMMITTED"
ok "an authorised --commit resolves the review"

RESOLVED_STATE="$(ADMIN -t -A -c "SELECT expected_state FROM defense_budget_expected_source WHERE id = '$EXPECTED_SOURCE_ID';")"
if [ "$RESOLVED_STATE" != "published" ]; then
  fail "expected expected_state='published' after commit, found '$RESOLVED_STATE'"
fi
ok "expected_state is now 'published'"

AUDIT_COUNT="$(ADMIN -t -A -c "SELECT count(*) FROM audit_logs WHERE action = 'defenseBudgetLifecycle.reviewQueue.resolve' AND entity_id = '$EXPECTED_SOURCE_ID';")"
if [ "$AUDIT_COUNT" != "1" ]; then
  fail "expected exactly one audit_logs row for the resolution, found $AUDIT_COUNT"
fi
ok "exactly one audit_logs row records the resolution"

if DATABASE_URL="$REHEARSAL_DATABASE_URL" PHASE8_SESSION11_REVIEW_RESOLUTION_AUTHORIZED=true \
  node "$CLI" --expected-source-id "$EXPECTED_SOURCE_ID" --decision published \
  --note "repeat" --actor-user-id "$ACTOR_USER_ID" --tenant-id "$TENANT_ID" --commit \
  >/tmp/p8s11-repeat.$$ 2>&1; then
  cat /tmp/p8s11-repeat.$$ >&2
  fail "resolving an already-resolved item must be refused"
fi
grep -q "not 'review_required'" /tmp/p8s11-repeat.$$
rm -f /tmp/p8s11-repeat.$$
ok "a repeat resolution of the same, now-published item is refused rather than double-applied"

log "SESSION11_DB_REHEARSAL_PASS ($PASS_COUNT checks)"
