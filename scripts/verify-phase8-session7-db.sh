#!/usr/bin/env bash
# Disposable PostgreSQL 16 rehearsal for Phase 8 Session 7 (Workstream J).
#
# Proves the full migration ledger applies from zero and that the DATABASE — not
# application convention — refuses the things Session 7 must never allow:
#
#   * an ambiguous source being queued for governed ingestion;
#   * an already-queued observation being pushed back into review;
#   * the same official bytes producing two observations, or two ingestion jobs;
#   * a lifecycle signal carrying a funding amount at any nesting depth;
#   * a watcher adapter declaring a GPU dependency;
#   * the HTTP serve role writing, or the job role deleting audit history;
#   * any monetary column existing in the control plane at all.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
API_ROOT="$REPO_ROOT/apps/api"
IMAGE="${P8S7_REHEARSAL_PG_IMAGE:-pgvector/pgvector:pg16}"
PORT="${P8S7_REHEARSAL_PG_PORT:-55470}"
NAME="p8s7-lifecycle-rehearsal"
SUPERUSER="capiro"
SUPERPASS="capiro"
DB_NAME="capiro"
SERVE_LOGIN="p8s7_serve_rehearsal"
JOB_LOGIN="p8s7_job_rehearsal"
LOGIN_PASSWORD="p8s7-rehearsal-pw"
PASS_COUNT=0
log()  { echo "[p8s7-db-rehearsal] $*"; }
fail() { echo "[p8s7-db-rehearsal] FAILED: $*" >&2; exit 1; }
ok()   { PASS_COUNT=$((PASS_COUNT + 1)); echo "[p8s7-db-rehearsal]   ok  $*"; }

SELF_MANAGED=0
if [ -n "${REHEARSAL_DATABASE_URL:-}" ]; then
  log "Using externally supplied REHEARSAL_DATABASE_URL"
else
  SELF_MANAGED=1
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" \
    -e POSTGRES_USER="$SUPERUSER" -e POSTGRES_PASSWORD="$SUPERPASS" -e POSTGRES_DB="$DB_NAME" \
    -p "$PORT:5432" "$IMAGE" >/dev/null
  for _ in $(seq 1 60); do
    docker exec "$NAME" pg_isready -U "$SUPERUSER" -d "$DB_NAME" >/dev/null 2>&1 && break
    sleep 1
  done
  docker exec "$NAME" pg_isready -U "$SUPERUSER" -d "$DB_NAME" >/dev/null 2>&1 \
    || fail "PostgreSQL did not become ready"
  REHEARSAL_DATABASE_URL="postgresql://$SUPERUSER:$SUPERPASS@localhost:$PORT/$DB_NAME"
fi
cleanup() {
  if [ "$SELF_MANAGED" = "1" ] && [ "${P8S7_REHEARSAL_KEEP:-0}" != "1" ]; then
    docker rm -f "$NAME" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

ADMIN=(psql "$REHEARSAL_DATABASE_URL" -v ON_ERROR_STOP=1 -q)
run_sql() { "${ADMIN[@]}" -c "$1" >/dev/null || fail "expected success: $1"; }
q()       { "${ADMIN[@]}" -tAc "$1"; }
login_url() {
  REHEARSAL_DATABASE_URL_="$REHEARSAL_DATABASE_URL" node -e '
    const u = new URL(process.env.REHEARSAL_DATABASE_URL_);
    u.username = process.argv[1]; u.password = process.argv[2]; process.stdout.write(u.toString());
  ' "$1" "$LOGIN_PASSWORD"
}
expect_fail() {
  local label="$1" url="$2" sql="$3"
  if psql "$url" -v ON_ERROR_STOP=1 -tAc "$sql" >/dev/null 2>&1; then
    fail "$label — database ACCEPTED a statement it must refuse"
  fi
  ok "$label — refused"
}
expect_ok() {
  local label="$1" url="$2" sql="$3"
  psql "$url" -v ON_ERROR_STOP=1 -tAc "$sql" >/dev/null 2>&1 \
    || fail "$label — database refused an expected statement"
  ok "$label"
}
hex64() { printf "$1%.0s" $(seq 1 64); }

log "1. Apply the full authoritative migration ledger from zero"
run_sql "$(cat "$REPO_ROOT/docker/postgres/init/01-extensions.sql")"
ok "extensions bootstrapped"
(cd "$API_ROOT" && DATABASE_URL="$REHEARSAL_DATABASE_URL" npx prisma migrate deploy --schema prisma/schema.prisma >/dev/null) \
  || fail "migration-from-zero failed"
ok "full migration ledger including Session 7 applied cleanly"
for t in defense_budget_cycle defense_budget_expected_source defense_budget_source_observation \
         defense_budget_watcher_adapter defense_budget_watcher_run \
         defense_budget_ingestion_outbox defense_budget_lifecycle_signal; do
  [ "$(q "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='$t';")" = "1" ] \
    || fail "$t missing"
done
ok "all seven Session 7 control-plane tables exist"

log "2. The control plane declares no monetary column anywhere"
MONEY="$(q "SELECT count(*) FROM information_schema.columns
  WHERE table_schema='public'
    AND table_name IN ('defense_budget_cycle','defense_budget_expected_source',
                       'defense_budget_source_observation','defense_budget_watcher_adapter',
                       'defense_budget_watcher_run','defense_budget_ingestion_outbox',
                       'defense_budget_lifecycle_signal')
    AND (column_name ~* '(amount|usd|dollar|obligat|outlay|appropriat|funding_level)'
         OR data_type = 'money');")"
[ "$MONEY" = "0" ] || fail "control plane declares $MONEY monetary column(s) — a missing source must never be zero"
ok "no monetary column exists in any Session 7 table"

log "3. Create least-privilege rehearsal logins"
run_sql "DROP ROLE IF EXISTS $SERVE_LOGIN; CREATE ROLE $SERVE_LOGIN LOGIN PASSWORD '$LOGIN_PASSWORD';"
run_sql "DROP ROLE IF EXISTS $JOB_LOGIN; CREATE ROLE $JOB_LOGIN LOGIN PASSWORD '$LOGIN_PASSWORD';"
run_sql "GRANT capiro_defense_serve TO $SERVE_LOGIN WITH INHERIT TRUE;"
run_sql "GRANT capiro_defense_job TO $JOB_LOGIN WITH INHERIT TRUE;"
SERVE_URL="$(login_url "$SERVE_LOGIN")"
JOB_URL="$(login_url "$JOB_LOGIN")"
ok "serve/job rehearsal logins created"

log "4. Bootstrap a cycle and an expected source through the job role"
SOURCE_ID="21111111-1111-4111-8111-111111111111"
CYCLE_AUTH="22222222-2222-4222-8222-222222222221"
CYCLE_APPR="22222222-2222-4222-8222-222222222222"
EXPECTED_AUTH="23333333-3333-4333-8333-333333333331"
EXPECTED_APPR="23333333-3333-4333-8333-333333333332"
run_sql "INSERT INTO source_document (
  id, source_key, fiscal_year, budget_cycle, component, document_type, title,
  source_url, sha256, extraction_method, metadata_jsonb
) VALUES (
  '$SOURCE_ID', 'p8s7-source', 2024, 'hasc', NULL, 'committee_report',
  'P8S7 source', 'https://www.govinfo.gov/example.pdf', repeat('a',64),
  'structured_import', '{}'::jsonb
);"

expect_ok "job creates an authorization cycle" "$JOB_URL" "INSERT INTO defense_budget_cycle
  (id, fiscal_year, authority_track, template_version, bootstrap_origin, dedup_key)
  VALUES ('$CYCLE_AUTH', 2024, 'authorization', 'defense_budget_cycle_template_v1', 'template', '$(hex64 b)');"
expect_ok "job creates an independent appropriations cycle" "$JOB_URL" "INSERT INTO defense_budget_cycle
  (id, fiscal_year, authority_track, template_version, bootstrap_origin, dedup_key)
  VALUES ('$CYCLE_APPR', 2024, 'appropriations', 'defense_budget_cycle_template_v1', 'template', '$(hex64 c)');"
expect_fail "a second cycle on the same (FY, track)" "$JOB_URL" "INSERT INTO defense_budget_cycle
  (fiscal_year, authority_track, template_version, bootstrap_origin, dedup_key)
  VALUES (2024, 'authorization', 'defense_budget_cycle_template_v1', 'template', '$(hex64 d)');"

expect_ok "job creates an expected source" "$JOB_URL" "INSERT INTO defense_budget_expected_source
  (id, cycle_id, fiscal_year, authority_track, stage, source_family, chamber, committee,
   adapter_id, label, template_version, expected_from, expected_to, dedup_key)
  VALUES ('$EXPECTED_AUTH', '$CYCLE_AUTH', 2024, 'authorization', 'hasc_report',
   'auth_committee_report', 'house', 'HASC', 'govinfo-committee-reports',
   'FY2024 HASC report', 'defense_budget_cycle_template_v1',
   now() - interval '60 days', now() - interval '10 days', '$(hex64 e)');"
expect_ok "job creates an appropriations expected source" "$JOB_URL" "INSERT INTO defense_budget_expected_source
  (id, cycle_id, fiscal_year, authority_track, stage, source_family, chamber, committee,
   adapter_id, label, template_version, expected_from, expected_to, dedup_key)
  VALUES ('$EXPECTED_APPR', '$CYCLE_APPR', 2024, 'appropriations', 'appr_enacted',
   'appr_public_law', NULL, NULL, 'govinfo-public-laws',
   'FY2024 enacted defense appropriations', 'defense_budget_cycle_template_v1',
   now() - interval '60 days', now() + interval '60 days', '$(hex64 f)');"
expect_fail "review_required state with no reason" "$JOB_URL" "UPDATE defense_budget_expected_source
  SET expected_state='review_required', review_reason=NULL WHERE id='$EXPECTED_AUTH';"
expect_ok "not_filed is a recordable state" "$JOB_URL" "UPDATE defense_budget_expected_source
  SET expected_state='not_filed' WHERE id='$EXPECTED_APPR';"
run_sql "UPDATE defense_budget_expected_source SET expected_state='expected' WHERE id='$EXPECTED_APPR';"

log "5. Fingerprint identity: identical bytes are ONE observation"
OBS_CLEAN="24444444-4444-4444-8444-444444444441"
OBS_REVIEW="24444444-4444-4444-8444-444444444442"
SHA_ONE="$(hex64 1)"
expect_ok "job records a classified observation" "$JOB_URL" "INSERT INTO defense_budget_source_observation
  (id, expected_source_id, cycle_id, adapter_id, discovered_url, content_sha256, byte_size,
   observation_state, revision_kind, classified_fiscal_year, classified_authority_track,
   classified_stage, classified_source_family, classification_confidence, dedup_key)
  VALUES ('$OBS_CLEAN', '$EXPECTED_AUTH', '$CYCLE_AUTH', 'govinfo-committee-reports',
   'https://www.govinfo.gov/content/pkg/CRPT-118hrpt125/pdf/CRPT-118hrpt125.pdf',
   '$SHA_ONE', 1709880, 'changed', 'first_discovery', 2024, 'authorization', 'hasc_report',
   'auth_committee_report', 0.950, '$(hex64 2)');"
expect_fail "the same expected source and the same bytes twice" "$JOB_URL" "INSERT INTO defense_budget_source_observation
  (expected_source_id, cycle_id, adapter_id, discovered_url, content_sha256,
   observation_state, revision_kind, dedup_key)
  VALUES ('$EXPECTED_AUTH', '$CYCLE_AUTH', 'govinfo-committee-reports',
   'https://www.govinfo.gov/relocated.pdf', '$SHA_ONE', 'unchanged', 'replacement_url', '$(hex64 3)');"
expect_fail "a malformed content sha" "$JOB_URL" "INSERT INTO defense_budget_source_observation
  (expected_source_id, cycle_id, adapter_id, discovered_url, content_sha256,
   observation_state, revision_kind, dedup_key)
  VALUES ('$EXPECTED_AUTH', '$CYCLE_AUTH', 'a', 'https://x', 'not-a-sha',
   'changed', 'changed', '$(hex64 4)');"
expect_fail "an ingested observation with no registered source identity" "$JOB_URL" "INSERT INTO defense_budget_source_observation
  (expected_source_id, cycle_id, adapter_id, discovered_url, content_sha256,
   observation_state, revision_kind, dedup_key)
  VALUES ('$EXPECTED_AUTH', '$CYCLE_AUTH', 'a', 'https://x', '$(hex64 5)',
   'ingested', 'changed', '$(hex64 6)');"

log "6. Ambiguity: a review_required observation claims no stage and cannot be queued"
expect_fail "review_required claiming a resolved track and stage" "$JOB_URL" "INSERT INTO defense_budget_source_observation
  (expected_source_id, cycle_id, adapter_id, discovered_url, content_sha256, observation_state,
   revision_kind, classified_authority_track, classified_stage, review_reasons, dedup_key)
  VALUES ('$EXPECTED_APPR', '$CYCLE_APPR', 'govinfo-public-laws', 'https://x', '$(hex64 7)',
   'review_required', 'first_discovery', 'appropriations', 'appr_enacted',
   '[\"ambiguous\"]'::jsonb, '$(hex64 8)');"
expect_fail "review_required with an empty reason list" "$JOB_URL" "INSERT INTO defense_budget_source_observation
  (expected_source_id, cycle_id, adapter_id, discovered_url, content_sha256, observation_state,
   revision_kind, dedup_key)
  VALUES ('$EXPECTED_APPR', '$CYCLE_APPR', 'govinfo-public-laws', 'https://x', '$(hex64 9)',
   'review_required', 'first_discovery', '$(hex64 0)');"
expect_ok "an honest review_required observation" "$JOB_URL" "INSERT INTO defense_budget_source_observation
  (id, expected_source_id, cycle_id, adapter_id, discovered_url, content_sha256, observation_state,
   revision_kind, review_reasons, dedup_key)
  VALUES ('$OBS_REVIEW', '$EXPECTED_APPR', '$CYCLE_APPR', 'govinfo-public-laws',
   'https://www.govinfo.gov/content/pkg/PLAW-118publ42/pdf/PLAW-118publ42.pdf', '$(hex64 a)',
   'review_required', 'first_discovery',
   '[\"omnibus/consolidated appropriations vehicle without proven Department of Defense division evidence\"]'::jsonb,
   '$(hex64 b)');"
expect_fail "queueing the ambiguous observation" "$JOB_URL" "INSERT INTO defense_budget_ingestion_outbox
  (observation_id, observation_state, cycle_id, job_kind, dedup_key)
  VALUES ('$OBS_REVIEW', 'review_required', '$CYCLE_APPR', 'governed_source_ingestion', '$(hex64 c)');"
expect_fail "lying about the observation state to slip past the CHECK" "$JOB_URL" "INSERT INTO defense_budget_ingestion_outbox
  (observation_id, observation_state, cycle_id, job_kind, dedup_key)
  VALUES ('$OBS_REVIEW', 'changed', '$CYCLE_APPR', 'governed_source_ingestion', '$(hex64 d)');"

log "7. Queue: exactly one governed job, and no double-enqueue"
expect_ok "the changed observation queues one job" "$JOB_URL" "INSERT INTO defense_budget_ingestion_outbox
  (observation_id, observation_state, cycle_id, job_kind, dedup_key)
  VALUES ('$OBS_CLEAN', 'changed', '$CYCLE_AUTH', 'governed_source_ingestion', '$(hex64 e)');"
expect_fail "a concurrent worker enqueueing the same job" "$JOB_URL" "INSERT INTO defense_budget_ingestion_outbox
  (observation_id, observation_state, cycle_id, job_kind, dedup_key)
  VALUES ('$OBS_CLEAN', 'changed', '$CYCLE_AUTH', 'governed_source_ingestion', '$(hex64 f)');"
expect_fail "pushing an already-queued observation back into review" "$JOB_URL" "UPDATE defense_budget_source_observation
  SET observation_state='review_required', review_reasons='[\"late ambiguity\"]'::jsonb,
      classified_authority_track=NULL, classified_stage=NULL
  WHERE id='$OBS_CLEAN';"
expect_ok "a legitimate advance to ingested cascades into the queue row" "$JOB_URL" "UPDATE defense_budget_source_observation
  SET observation_state='ingested', source_document_id='$SOURCE_ID' WHERE id='$OBS_CLEAN';"
[ "$(q "SELECT observation_state FROM defense_budget_ingestion_outbox WHERE observation_id='$OBS_CLEAN';")" = "ingested" ] \
  || fail "queue row did not follow the observation state through the cascade"
ok "queue row followed the observation state via ON UPDATE CASCADE"

log "8. Supersession keeps prior evidence"
OBS_V2="24444444-4444-4444-8444-444444444443"
expect_ok "a corrected version is recorded alongside the original" "$JOB_URL" "INSERT INTO defense_budget_source_observation
  (id, expected_source_id, cycle_id, adapter_id, discovered_url, content_sha256, observation_state,
   revision_kind, classified_fiscal_year, classified_authority_track, classified_stage,
   classified_source_family, dedup_key)
  VALUES ('$OBS_V2', '$EXPECTED_AUTH', '$CYCLE_AUTH', 'govinfo-committee-reports',
   'https://www.govinfo.gov/content/pkg/CRPT-118hrpt125/pdf/CRPT-118hrpt125.pdf',
   '$(hex64 2)', 'changed', 'changed', 2024, 'authorization', 'hasc_report',
   'auth_committee_report', '$(hex64 3)');"
expect_ok "the original is marked superseded" "$JOB_URL" "UPDATE defense_budget_source_observation
  SET superseded_by_observation_id='$OBS_V2', observation_state='superseded' WHERE id='$OBS_CLEAN';"
[ "$(q "SELECT content_sha256 FROM defense_budget_source_observation WHERE id='$OBS_CLEAN';")" = "$SHA_ONE" ] \
  || fail "superseding a version altered the prior evidence"
ok "superseded version retains its original bytes"
expect_fail "an observation superseding itself" "$JOB_URL" "UPDATE defense_budget_source_observation
  SET superseded_by_observation_id='$OBS_V2' WHERE id='$OBS_V2';"
expect_fail "job deleting a superseded observation" "$JOB_URL" "DELETE FROM defense_budget_source_observation WHERE id='$OBS_CLEAN';"

log "9. Signals are notifications, never funding assertions"
expect_ok "a signal with no dollars" "$JOB_URL" "INSERT INTO defense_budget_lifecycle_signal
  (cycle_id, signal_kind, fiscal_year, authority_track, from_stage, to_stage,
   from_observation_id, to_observation_id, dedup_key, payload_jsonb)
  VALUES ('$CYCLE_AUTH', 'source_correction', 2024, 'authorization', 'hasc_report', 'hasc_report',
   '$OBS_CLEAN', '$OBS_V2', '$(hex64 4)', '{\"note\":\"corrected committee report\"}'::jsonb);"
expect_fail "a signal carrying a top-level amount" "$JOB_URL" "INSERT INTO defense_budget_lifecycle_signal
  (cycle_id, signal_kind, fiscal_year, authority_track, from_stage, to_stage,
   from_observation_id, to_observation_id, dedup_key, payload_jsonb)
  VALUES ('$CYCLE_AUTH', 'pb_to_hasc', 2024, 'authorization', 'president_budget_request',
   'hasc_report', '$OBS_CLEAN', '$OBS_V2', '$(hex64 5)',
   '{\"authoritativeAmountUsd\":\"1400000000.00\"}'::jsonb);"
expect_fail "a signal carrying a NESTED amount" "$JOB_URL" "INSERT INTO defense_budget_lifecycle_signal
  (cycle_id, signal_kind, fiscal_year, authority_track, from_stage, to_stage,
   from_observation_id, to_observation_id, dedup_key, payload_jsonb)
  VALUES ('$CYCLE_AUTH', 'pb_to_hasc', 2024, 'authorization', 'president_budget_request',
   'hasc_report', '$OBS_CLEAN', '$OBS_V2', '$(hex64 6)',
   '{\"delta\":{\"inner\":{\"amountUsd\":123}}}'::jsonb);"
expect_fail "a signal comparing an observation to itself" "$JOB_URL" "INSERT INTO defense_budget_lifecycle_signal
  (cycle_id, signal_kind, fiscal_year, authority_track, from_stage, to_stage,
   from_observation_id, to_observation_id, dedup_key)
  VALUES ('$CYCLE_AUTH', 'source_correction', 2024, 'authorization', 'hasc_report', 'hasc_report',
   '$OBS_V2', '$OBS_V2', '$(hex64 7)');"

log "10. Watcher state: no GPU dependency, bounded queue accounting"
expect_ok "job registers a CPU/network adapter" "$JOB_URL" "INSERT INTO defense_budget_watcher_adapter
  (adapter_id, status, next_check_at) VALUES ('govinfo-committee-reports', 'idle', now() + interval '3 hours');"
expect_fail "an adapter declaring a GPU dependency" "$JOB_URL" "INSERT INTO defense_budget_watcher_adapter
  (adapter_id, requires_gpu) VALUES ('gpu-adapter', TRUE);"
expect_fail "flipping an existing adapter to require GPU" "$JOB_URL" "UPDATE defense_budget_watcher_adapter
  SET requires_gpu = TRUE WHERE adapter_id='govinfo-committee-reports';"
expect_fail "a lease owner with no expiry" "$JOB_URL" "UPDATE defense_budget_watcher_adapter
  SET lease_owner='worker-a', lease_expires_at=NULL WHERE adapter_id='govinfo-committee-reports';"
expect_ok "a well-formed lease" "$JOB_URL" "UPDATE defense_budget_watcher_adapter
  SET lease_owner='worker-a', lease_expires_at=now() + interval '15 minutes'
  WHERE adapter_id='govinfo-committee-reports';"
expect_ok "a completed run" "$JOB_URL" "INSERT INTO defense_budget_watcher_run
  (adapter_id, run_key, status, finished_at, discovered_count, unchanged_count, changed_count, queued_count)
  VALUES ('govinfo-committee-reports', 'run-1', 'succeeded', now(), 3, 2, 1, 1);"
expect_fail "a run queueing more work than it observed changes" "$JOB_URL" "INSERT INTO defense_budget_watcher_run
  (adapter_id, run_key, status, finished_at, discovered_count, changed_count, queued_count)
  VALUES ('govinfo-committee-reports', 'run-2', 'succeeded', now(), 3, 1, 5);"
expect_fail "a finished run with no finish time" "$JOB_URL" "INSERT INTO defense_budget_watcher_run
  (adapter_id, run_key, status) VALUES ('govinfo-committee-reports', 'run-3', 'succeeded');"
expect_fail "the same run key twice for one adapter" "$JOB_URL" "INSERT INTO defense_budget_watcher_run
  (adapter_id, run_key, status, finished_at) VALUES ('govinfo-committee-reports', 'run-1', 'failed', now());"

log "11. Role boundary: HTTP serve reads, job cannot delete history"
expect_ok "serve reads cycle health" "$SERVE_URL" "SELECT count(*) FROM defense_budget_cycle;"
expect_ok "serve reads expected sources" "$SERVE_URL" "SELECT count(*) FROM defense_budget_expected_source;"
expect_ok "serve reads observations" "$SERVE_URL" "SELECT count(*) FROM defense_budget_source_observation;"
expect_ok "serve reads the queue" "$SERVE_URL" "SELECT count(*) FROM defense_budget_ingestion_outbox;"
expect_fail "serve inserting an observation" "$SERVE_URL" "INSERT INTO defense_budget_source_observation
  (expected_source_id, cycle_id, adapter_id, discovered_url, content_sha256, revision_kind, dedup_key)
  VALUES ('$EXPECTED_AUTH', '$CYCLE_AUTH', 'x', 'https://x', '$(hex64 8)', 'changed', '$(hex64 9)');"
expect_fail "serve mutating the queue" "$SERVE_URL" "UPDATE defense_budget_ingestion_outbox SET state='succeeded';"
expect_fail "serve emitting a signal" "$SERVE_URL" "INSERT INTO defense_budget_lifecycle_signal
  (cycle_id, signal_kind, fiscal_year, authority_track, from_stage, to_stage,
   from_observation_id, to_observation_id, dedup_key)
  VALUES ('$CYCLE_AUTH', 'pb_to_hasc', 2024, 'authorization', 'president_budget_request',
   'hasc_report', '$OBS_CLEAN', '$OBS_V2', '$(hex64 0)');"
expect_ok "job updates queue state" "$JOB_URL" "UPDATE defense_budget_ingestion_outbox SET state='succeeded';"
expect_fail "job deleting signals" "$JOB_URL" "DELETE FROM defense_budget_lifecycle_signal;"
expect_fail "job deleting watcher runs" "$JOB_URL" "DELETE FROM defense_budget_watcher_run;"
expect_fail "job deleting queue rows" "$JOB_URL" "DELETE FROM defense_budget_ingestion_outbox;"
expect_fail "job deleting cycles" "$JOB_URL" "DELETE FROM defense_budget_cycle;"
expect_fail "job running DDL on the control plane" "$JOB_URL" "ALTER TABLE defense_budget_cycle ADD COLUMN sneaky_amount_usd numeric;"

log "12. Session 7 grants no promotion or snapshot-activation authority"
for tbl in defense_budget_promotion_run defense_budget_active_snapshot; do
  if [ "$(q "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='$tbl';")" = "1" ]; then
    expect_fail "job writing $tbl" "$JOB_URL" "INSERT INTO $tbl DEFAULT VALUES;"
  fi
done
ok "no Session 7 role gained promotion or snapshot-activation authority"

log "13. Alternative funding did not leak into ProgramElementYear"
LEAKS="$(q "SELECT count(*) FROM information_schema.columns
  WHERE table_name='program_element_year'
    AND column_name ~* '(supplement|reconciliation|rescission|transfer|reprogramming|continuing)';")"
[ "$LEAKS" = "0" ] || fail "alternative funding columns leaked into program_element_year"
ok "ProgramElementYear remains annual-stage only"

log "14. Observations are bound to immutable source identity"
expect_fail "an observation citing a fabricated source_document" "$JOB_URL" "UPDATE defense_budget_source_observation
  SET source_document_id='99999999-9999-4999-8999-999999999999' WHERE id='$OBS_V2';"
ok "source evidence foreign key holds"

log "SESSION7_DB_REHEARSAL_PASS ($PASS_COUNT checks)"
