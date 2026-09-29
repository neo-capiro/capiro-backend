#!/usr/bin/env bash
# Disposable PostgreSQL 16 rehearsal for Phase 8 Session 8 (live source discovery).
#
# Proves the full migration ledger still applies from zero with Session 8 added,
# and that the DATABASE — not application convention — refuses the things live
# discovery must never allow:
#
#   * an unresolved candidate carrying an expected-source dedup key, or a
#     resolved one carrying none (the fabricated-identity guarantee, both ways);
#   * an unresolved candidate being marked as emitted to the control loop;
#   * a publisher refusal being recorded as a successful crawl;
#   * an unreachable host carrying an HTTP status it never returned;
#   * a failed crawl with no stated reason;
#   * a non-https request or candidate URL;
#   * the same candidate being recorded twice for one run;
#   * two workers both believing they may hit a shared host immediately;
#   * the serve role writing, or the job role deleting, crawl history;
#   * any monetary column existing in the discovery tables at all.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
API_ROOT="$REPO_ROOT/apps/api"
IMAGE="${P8S8_REHEARSAL_PG_IMAGE:-pgvector/pgvector:pg16}"
PORT="${P8S8_REHEARSAL_PG_PORT:-55480}"
NAME="p8s8-discovery-rehearsal"
SUPERUSER="capiro"
SUPERPASS="capiro"
DB_NAME="capiro"
SERVE_LOGIN="p8s8_serve_rehearsal"
JOB_LOGIN="p8s8_job_rehearsal"
LOGIN_PASSWORD="p8s8-rehearsal-pw"
PASS_COUNT=0
log()  { echo "[p8s8-db-rehearsal] $*"; }
fail() { echo "[p8s8-db-rehearsal] FAILED: $*" >&2; exit 1; }
ok()   { PASS_COUNT=$((PASS_COUNT + 1)); echo "[p8s8-db-rehearsal]   ok  $*"; }

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
    # The entrypoint's temporary Unix-socket server precedes database creation.
    docker exec "$NAME" pg_isready -h 127.0.0.1 -U "$SUPERUSER" -d "$DB_NAME" >/dev/null 2>&1 && break
    sleep 1
  done
  docker exec "$NAME" pg_isready -h 127.0.0.1 -U "$SUPERUSER" -d "$DB_NAME" >/dev/null 2>&1 \
    || fail "PostgreSQL did not become ready"
  REHEARSAL_DATABASE_URL="postgresql://$SUPERUSER:$SUPERPASS@localhost:$PORT/$DB_NAME"
fi
cleanup() {
  if [ "$SELF_MANAGED" = "1" ] && [ "${P8S8_REHEARSAL_KEEP:-0}" != "1" ]; then
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
if [ "$SELF_MANAGED" = "1" ]; then
  docker exec -i "$NAME" psql -X -U "$SUPERUSER" -d "$DB_NAME" -v ON_ERROR_STOP=1 < "$REPO_ROOT/scripts/ci/disposable-capiro-worker-prerequisite.sql"
  docker exec -i "$NAME" psql -X -U "$SUPERUSER" -d "$DB_NAME" -v ON_ERROR_STOP=1 < "$REPO_ROOT/scripts/ci/research-portfolio-append-only-prerequisite.sql"
fi
run_sql "$(cat "$REPO_ROOT/docker/postgres/init/01-extensions.sql")"
ok "extensions bootstrapped"
(cd "$API_ROOT" && DATABASE_URL="$REHEARSAL_DATABASE_URL" npx prisma migrate deploy --schema prisma/schema.prisma >/dev/null) \
  || fail "migration-from-zero failed"
ok "full migration ledger including Session 8 applied cleanly"

for t in defense_budget_discovery_crawl defense_budget_discovery_candidate \
         defense_budget_discovery_host_budget; do
  [ "$(q "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='$t';")" = "1" ] \
    || fail "$t missing"
done
ok "all three Session 8 discovery tables exist"

log "2. Session 7 control plane is untouched by Session 8"
for t in defense_budget_cycle defense_budget_expected_source defense_budget_source_observation \
         defense_budget_watcher_adapter defense_budget_watcher_run \
         defense_budget_ingestion_outbox defense_budget_lifecycle_signal; do
  [ "$(q "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='$t';")" = "1" ] \
    || fail "Session 7 table $t missing after Session 8"
done
ok "all seven Session 7 control-plane tables still exist"

log "3. The discovery tables declare no monetary column anywhere"
MONEY="$(q "SELECT count(*) FROM information_schema.columns
  WHERE table_schema='public'
    AND table_name IN ('defense_budget_discovery_crawl','defense_budget_discovery_candidate',
                       'defense_budget_discovery_host_budget')
    AND (column_name ~* '(amount|usd|dollar|obligat|outlay|appropriat|funding_level)'
         OR data_type = 'money');")"
[ "$MONEY" = "0" ] || fail "discovery declares $MONEY monetary column(s) — discovery cannot assert dollars"
ok "no monetary column exists in any Session 8 table (measured $MONEY)"

log "4. Create least-privilege rehearsal logins"
run_sql "DROP ROLE IF EXISTS $SERVE_LOGIN; CREATE ROLE $SERVE_LOGIN LOGIN PASSWORD '$LOGIN_PASSWORD';"
run_sql "DROP ROLE IF EXISTS $JOB_LOGIN; CREATE ROLE $JOB_LOGIN LOGIN PASSWORD '$LOGIN_PASSWORD';"
run_sql "GRANT capiro_defense_serve TO $SERVE_LOGIN WITH INHERIT TRUE;"
run_sql "GRANT capiro_defense_job TO $JOB_LOGIN WITH INHERIT TRUE;"
SERVE_URL="$(login_url "$SERVE_LOGIN")"
JOB_URL="$(login_url "$JOB_LOGIN")"
ok "serve/job rehearsal logins created"

CRAWL_OK="31111111-1111-4111-8111-111111111111"
CRAWL_BLOCKED="31111111-1111-4111-8111-111111111112"
CRAWL_UNREACHABLE="31111111-1111-4111-8111-111111111113"
SITEMAP_URL="https://www.govinfo.gov/sitemap/CRPT_sitemap_index.xml"
PDF_URL="https://www.govinfo.gov/content/pkg/CRPT-118hrpt125/pdf/CRPT-118hrpt125.pdf"

log "5. A successful crawl records its real status and bytes"
expect_ok "job records a successful sitemap crawl" "$JOB_URL" "INSERT INTO defense_budget_discovery_crawl
  (id, adapter_id, run_key, request_url, resource_kind, status_code, status, content_sha256,
   byte_size, items_seen, robots_unavailable, effective_interval_ms, started_at, finished_at)
  VALUES ('$CRAWL_OK','govinfo-committee-reports','run-1','$SITEMAP_URL','sitemap_index',200,
          'succeeded','$(hex64 a)',91137,497,false,1000,now(),now());"

log "6. A refusal cannot be recorded as a success"
expect_fail "a 'succeeded' crawl carrying a 403" "$JOB_URL" "INSERT INTO defense_budget_discovery_crawl
  (adapter_id, run_key, request_url, resource_kind, status_code, status,
   effective_interval_ms, started_at, finished_at)
  VALUES ('dod-comptroller','run-1','https://comptroller.defense.gov/Budget-Materials/','listing',
          403,'succeeded',2000,now(),now());"
expect_fail "a 'succeeded' crawl carrying no status at all" "$JOB_URL" "INSERT INTO defense_budget_discovery_crawl
  (adapter_id, run_key, request_url, resource_kind, status, effective_interval_ms,
   started_at, finished_at)
  VALUES ('dod-comptroller','run-1','https://comptroller.defense.gov/x','listing',
          'succeeded',2000,now(),now());"
expect_ok "the real Akamai 403 recorded as a publisher block" "$JOB_URL" "INSERT INTO defense_budget_discovery_crawl
  (id, adapter_id, run_key, request_url, resource_kind, status_code, status,
   effective_interval_ms, started_at, finished_at, failure_reason)
  VALUES ('$CRAWL_BLOCKED','dod-comptroller','run-1',
          'https://comptroller.defense.gov/Budget-Materials/','listing',403,'blocked_by_publisher',
          2000,now(),now(),'HTTP 403 from comptroller.defense.gov');"
expect_fail "a publisher block with no status code" "$JOB_URL" "INSERT INTO defense_budget_discovery_crawl
  (adapter_id, run_key, request_url, resource_kind, status, effective_interval_ms,
   started_at, finished_at, failure_reason)
  VALUES ('dod-comptroller','run-2','https://comptroller.defense.gov/y','listing',
          'blocked_by_publisher',2000,now(),now(),'refused');"

log "7. An unreachable host cannot carry a status it never returned"
expect_ok "the real saffm.hq.af.mil non-connection" "$JOB_URL" "INSERT INTO defense_budget_discovery_crawl
  (id, adapter_id, run_key, request_url, resource_kind, status, effective_interval_ms,
   started_at, finished_at, failure_reason)
  VALUES ('$CRAWL_UNREACHABLE','saf-fm-budget','run-1','https://www.saffm.hq.af.mil/FM-Resources/Budget/',
          'listing','unreachable',2000,now(),now(),'getaddrinfo ENOTFOUND');"
expect_fail "an 'unreachable' crawl carrying an HTTP status" "$JOB_URL" "INSERT INTO defense_budget_discovery_crawl
  (adapter_id, run_key, request_url, resource_kind, status_code, status, effective_interval_ms,
   started_at, finished_at, failure_reason)
  VALUES ('saf-fm-budget','run-2','https://www.saffm.hq.af.mil/x','listing',500,'unreachable',
          2000,now(),now(),'nope');"
expect_fail "a failed crawl with no stated reason" "$JOB_URL" "INSERT INTO defense_budget_discovery_crawl
  (adapter_id, run_key, request_url, resource_kind, status, effective_interval_ms,
   started_at, finished_at)
  VALUES ('saf-fm-budget','run-3','https://www.saffm.hq.af.mil/z','listing','unreachable',
          2000,now(),now());"

log "8. Only https, and only a coherent time window"
expect_fail "a plaintext request url" "$JOB_URL" "INSERT INTO defense_budget_discovery_crawl
  (adapter_id, run_key, request_url, resource_kind, status_code, status, effective_interval_ms,
   started_at, finished_at)
  VALUES ('govinfo-bills','run-1','http://www.govinfo.gov/sitemap/x.xml','sitemap',200,'succeeded',
          1000,now(),now());"
expect_fail "a crawl that finished before it started" "$JOB_URL" "INSERT INTO defense_budget_discovery_crawl
  (adapter_id, run_key, request_url, resource_kind, status_code, status, effective_interval_ms,
   started_at, finished_at)
  VALUES ('govinfo-bills','run-1','https://www.govinfo.gov/sitemap/y.xml','sitemap',200,'succeeded',
          1000,now(),now() - interval '1 hour');"
expect_fail "a negative request interval" "$JOB_URL" "INSERT INTO defense_budget_discovery_crawl
  (adapter_id, run_key, request_url, resource_kind, status_code, status, effective_interval_ms,
   started_at, finished_at)
  VALUES ('govinfo-bills','run-1','https://www.govinfo.gov/sitemap/z.xml','sitemap',200,'succeeded',
          -1,now(),now());"
expect_fail "an unknown resource kind" "$JOB_URL" "INSERT INTO defense_budget_discovery_crawl
  (adapter_id, run_key, request_url, resource_kind, status_code, status, effective_interval_ms,
   started_at, finished_at)
  VALUES ('govinfo-bills','run-1','https://www.govinfo.gov/sitemap/q.xml','telepathy',200,
          'succeeded',1000,now(),now());"
expect_fail "an unknown crawl status" "$JOB_URL" "INSERT INTO defense_budget_discovery_crawl
  (adapter_id, run_key, request_url, resource_kind, status_code, status, effective_interval_ms,
   started_at, finished_at)
  VALUES ('govinfo-bills','run-1','https://www.govinfo.gov/sitemap/r.xml','sitemap',200,
          'probably_fine',1000,now(),now());"

log "9. The fabricated-identity guarantee, enforced in BOTH directions"
expect_ok "a resolved candidate carrying a dedup key" "$JOB_URL" "INSERT INTO defense_budget_discovery_candidate
  (crawl_id, adapter_id, run_key, candidate_url, package_id, title, resolution,
   expected_source_dedup_key, classified_fiscal_year, reason, emitted, observed_at)
  VALUES ('$CRAWL_OK','govinfo-committee-reports','run-1','$PDF_URL','CRPT-118hrpt125',
          'NATIONAL DEFENSE AUTHORIZATION ACT FOR FISCAL YEAR 2024','resolved','$(hex64 b)',2024,
          'resolved from publisher metadata',true,now());"
expect_fail "an UNRESOLVED candidate carrying a dedup key" "$JOB_URL" "INSERT INTO defense_budget_discovery_candidate
  (crawl_id, adapter_id, run_key, candidate_url, resolution, expected_source_dedup_key,
   reason, emitted, observed_at)
  VALUES ('$CRAWL_OK','govinfo-committee-reports','run-1',
          'https://www.govinfo.gov/content/pkg/CRPT-118hrpt999/pdf/CRPT-118hrpt999.pdf',
          'unresolved_not_defense_subject','$(hex64 c)','post office naming',false,now());"
expect_fail "a RESOLVED candidate carrying no dedup key" "$JOB_URL" "INSERT INTO defense_budget_discovery_candidate
  (crawl_id, adapter_id, run_key, candidate_url, resolution, reason, emitted, observed_at)
  VALUES ('$CRAWL_OK','govinfo-committee-reports','run-1',
          'https://www.govinfo.gov/content/pkg/CRPT-118hrpt998/pdf/CRPT-118hrpt998.pdf',
          'resolved','claims resolution without an identity',true,now());"

log "10. Only a resolved candidate may be emitted to the control loop"
expect_fail "an unresolved candidate marked emitted" "$JOB_URL" "INSERT INTO defense_budget_discovery_candidate
  (crawl_id, adapter_id, run_key, candidate_url, resolution, reason, emitted, observed_at)
  VALUES ('$CRAWL_OK','govinfo-committee-reports','run-1',
          'https://www.govinfo.gov/content/pkg/CRPT-118hrpt997/pdf/CRPT-118hrpt997.pdf',
          'unresolved_no_registered_expected_source','nothing expects this',true,now());"
expect_ok "an unresolved candidate recorded, not emitted" "$JOB_URL" "INSERT INTO defense_budget_discovery_candidate
  (crawl_id, adapter_id, run_key, candidate_url, package_id, title, resolution,
   reason, emitted, observed_at)
  VALUES ('$CRAWL_OK','govinfo-committee-reports','run-1',
          'https://www.govinfo.gov/content/pkg/CRPT-118hrpt402/pdf/CRPT-118hrpt402.pdf',
          'CRPT-118hrpt402','DESIGNATING A POST OFFICE','unresolved_not_defense_subject',
          'metadata does not identify a defense budget document',false,now());"
expect_fail "an unknown resolution outcome" "$JOB_URL" "INSERT INTO defense_budget_discovery_candidate
  (crawl_id, adapter_id, run_key, candidate_url, resolution, reason, emitted, observed_at)
  VALUES ('$CRAWL_OK','govinfo-committee-reports','run-1',
          'https://www.govinfo.gov/content/pkg/CRPT-1/pdf/CRPT-1.pdf','probably_ours',
          'vibes',false,now());"
expect_fail "a candidate with a blank reason" "$JOB_URL" "INSERT INTO defense_budget_discovery_candidate
  (crawl_id, adapter_id, run_key, candidate_url, resolution, reason, emitted, observed_at)
  VALUES ('$CRAWL_OK','govinfo-committee-reports','run-1',
          'https://www.govinfo.gov/content/pkg/CRPT-2/pdf/CRPT-2.pdf',
          'unresolved_not_defense_subject','   ',false,now());"
expect_fail "a plaintext candidate url" "$JOB_URL" "INSERT INTO defense_budget_discovery_candidate
  (crawl_id, adapter_id, run_key, candidate_url, resolution, reason, emitted, observed_at)
  VALUES ('$CRAWL_OK','govinfo-committee-reports','run-1','http://www.govinfo.gov/x.pdf',
          'unresolved_not_defense_subject','plaintext',false,now());"
expect_fail "an implausible classified fiscal year" "$JOB_URL" "INSERT INTO defense_budget_discovery_candidate
  (crawl_id, adapter_id, run_key, candidate_url, resolution, expected_source_dedup_key,
   classified_fiscal_year, reason, emitted, observed_at)
  VALUES ('$CRAWL_OK','govinfo-committee-reports','run-1',
          'https://www.govinfo.gov/content/pkg/CRPT-3/pdf/CRPT-3.pdf','resolved','$(hex64 d)',
          9999,'year from the far future',true,now());"

log "11. The audit trail is idempotent under retry"
expect_fail "the same candidate twice in one run" "$JOB_URL" "INSERT INTO defense_budget_discovery_candidate
  (crawl_id, adapter_id, run_key, candidate_url, resolution, expected_source_dedup_key,
   reason, emitted, observed_at)
  VALUES ('$CRAWL_OK','govinfo-committee-reports','run-1','$PDF_URL','resolved','$(hex64 b)',
          'duplicate',true,now());"
expect_ok "the same candidate in a DIFFERENT run" "$JOB_URL" "INSERT INTO defense_budget_discovery_candidate
  (crawl_id, adapter_id, run_key, candidate_url, resolution, expected_source_dedup_key,
   reason, emitted, observed_at)
  VALUES ('$CRAWL_OK','govinfo-committee-reports','run-2','$PDF_URL','resolved','$(hex64 b)',
          're-observed on a later run',true,now());"

log "12. A candidate cannot be orphaned from the crawl that produced it"
expect_fail "a candidate citing a crawl that does not exist" "$JOB_URL" "INSERT INTO defense_budget_discovery_candidate
  (crawl_id, adapter_id, run_key, candidate_url, resolution, reason, emitted, observed_at)
  VALUES ('99999999-9999-4999-8999-999999999999','govinfo-bills','run-9',
          'https://www.govinfo.gov/content/pkg/CRPT-9/pdf/CRPT-9.pdf',
          'unresolved_not_defense_subject','orphan',false,now());"
expect_fail "deleting a crawl that has candidates" "$JOB_URL" "DELETE FROM defense_budget_discovery_crawl WHERE id='$CRAWL_OK';"

log "13. Host pacing is atomic and shared across adapters on the same host"
# Two GovInfo adapters share www.govinfo.gov. The reservation is one statement.
FIRST_WAIT="$(q "INSERT INTO defense_budget_discovery_host_budget AS hb
    (host, next_request_allowed_at, last_reserved_at, reservation_count)
  VALUES ('www.govinfo.gov', '2026-08-21T00:00:00Z'::timestamptz + make_interval(secs => 1000/1000.0),
          '2026-08-21T00:00:00Z', 1)
  ON CONFLICT (host) DO UPDATE SET
    next_request_allowed_at = GREATEST(hb.next_request_allowed_at, '2026-08-21T00:00:00Z'::timestamptz)
      + make_interval(secs => 1000/1000.0),
    reservation_count = hb.reservation_count + 1
  RETURNING GREATEST(0, EXTRACT(EPOCH FROM (hb.next_request_allowed_at
      - make_interval(secs => 1000/1000.0) - '2026-08-21T00:00:00Z'::timestamptz)) * 1000)::bigint;")"
[ "$FIRST_WAIT" = "0" ] || fail "a first reservation should not wait, got ${FIRST_WAIT}ms"
ok "first reservation on a host is immediate"

SECOND_WAIT="$(q "INSERT INTO defense_budget_discovery_host_budget AS hb
    (host, next_request_allowed_at, last_reserved_at, reservation_count)
  VALUES ('www.govinfo.gov', '2026-08-21T00:00:00Z'::timestamptz + make_interval(secs => 1000/1000.0),
          '2026-08-21T00:00:00Z', 1)
  ON CONFLICT (host) DO UPDATE SET
    next_request_allowed_at = GREATEST(hb.next_request_allowed_at, '2026-08-21T00:00:00Z'::timestamptz)
      + make_interval(secs => 1000/1000.0),
    reservation_count = hb.reservation_count + 1
  RETURNING GREATEST(0, EXTRACT(EPOCH FROM (hb.next_request_allowed_at
      - make_interval(secs => 1000/1000.0) - '2026-08-21T00:00:00Z'::timestamptz)) * 1000)::bigint;")"
[ "$SECOND_WAIT" = "1000" ] || fail "a second reservation on the same host must wait 1000ms, got ${SECOND_WAIT}ms"
ok "a second reservation on the SAME host is spaced, whichever adapter asked"

RESERVATIONS="$(q "SELECT reservation_count FROM defense_budget_discovery_host_budget WHERE host='www.govinfo.gov';")"
[ "$RESERVATIONS" = "2" ] || fail "expected 2 reservations, got $RESERVATIONS"
ok "reservations are counted per host, not per adapter"

expect_fail "a blank host" "$JOB_URL" "INSERT INTO defense_budget_discovery_host_budget
  (host, next_request_allowed_at) VALUES ('  ', now());"

log "14. Role boundary: serve reads, job never deletes"
expect_ok "serve reads crawl history" "$SERVE_URL" "SELECT count(*) FROM defense_budget_discovery_crawl;"
expect_ok "serve reads candidate history" "$SERVE_URL" "SELECT count(*) FROM defense_budget_discovery_candidate;"
expect_ok "serve reads host pacing" "$SERVE_URL" "SELECT count(*) FROM defense_budget_discovery_host_budget;"
expect_fail "serve writing a crawl row" "$SERVE_URL" "INSERT INTO defense_budget_discovery_crawl
  (adapter_id, run_key, request_url, resource_kind, status_code, status, effective_interval_ms,
   started_at, finished_at)
  VALUES ('govinfo-bills','serve','https://www.govinfo.gov/a.xml','sitemap',200,'succeeded',
          1000,now(),now());"
expect_fail "serve writing a candidate row" "$SERVE_URL" "UPDATE defense_budget_discovery_candidate SET emitted = false;"
expect_fail "job deleting candidate history" "$JOB_URL" "DELETE FROM defense_budget_discovery_candidate;"
expect_fail "job deleting crawl history" "$JOB_URL" "DELETE FROM defense_budget_discovery_crawl WHERE id='$CRAWL_UNREACHABLE';"
expect_fail "job deleting host pacing state" "$JOB_URL" "DELETE FROM defense_budget_discovery_host_budget;"
expect_fail "job running DDL on discovery" "$JOB_URL" "ALTER TABLE defense_budget_discovery_candidate ADD COLUMN sneaky_amount_usd numeric;"

log "15. Session 8 grants no promotion or snapshot-activation authority"
for tbl in defense_budget_promotion_run defense_budget_active_snapshot; do
  if [ "$(q "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='$tbl';")" = "1" ]; then
    expect_fail "job writing $tbl" "$JOB_URL" "INSERT INTO $tbl DEFAULT VALUES;"
  fi
done
ok "no Session 8 role gained promotion or snapshot-activation authority"

log "16. Discovery did not leak into ProgramElementYear or the Session 7 tables"
LEAKS="$(q "SELECT count(*) FROM information_schema.columns
  WHERE table_name='program_element_year'
    AND column_name ~* '(discovery|crawl|robots|sitemap|candidate_url)';")"
[ "$LEAKS" = "0" ] || fail "discovery columns leaked into program_element_year"
ok "ProgramElementYear is untouched by discovery"

S7_LEAKS="$(q "SELECT count(*) FROM information_schema.columns
  WHERE table_schema='public'
    AND table_name LIKE 'defense_budget_%'
    AND table_name NOT LIKE 'defense_budget_discovery%'
    AND column_name ~* '(robots|sitemap|crawl_id)';")"
[ "$S7_LEAKS" = "0" ] || fail "discovery columns leaked into the Session 7 control plane"
ok "the Session 7 control plane gained no discovery column"

log "17. Discovery cannot enqueue governed ingestion directly"
# Only the Session 7 watcher may enqueue, and only from a queueable observation.
expect_fail "discovery inserting straight into the ingestion outbox" "$JOB_URL" "INSERT INTO defense_budget_ingestion_outbox
  (observation_id, observation_state, cycle_id, job_kind, dedup_key)
  VALUES ('99999999-9999-4999-8999-999999999999','classified',
          '99999999-9999-4999-8999-999999999998','governed_source_ingestion','$(hex64 e)');"

log "SESSION8_DB_REHEARSAL_PASS ($PASS_COUNT checks)"
