#!/usr/bin/env bash
# Disposable PostgreSQL 16 rehearsal for Phase 8 Session 9 (provider runtime).
#
# Proves the full migration ledger still applies from zero with Session 9 added,
# and that the DATABASE — not application convention — refuses the things a
# provider audit must never allow:
#
#   * a failed invocation with no named failure class, or a success carrying one;
#   * a degraded invocation claiming an embedding dimension it never received;
#   * a success that produced nothing;
#   * a relevance call carrying a model, or an embedding call carrying a count;
#   * an audit row with no stated reason;
#   * a rewritable or deletable audit row, from either role;
#   * the serve role gaining write access to anything OTHER than this table;
#   * any monetary or cost column existing at all.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
API_ROOT="$REPO_ROOT/apps/api"
IMAGE="${P8S9_REHEARSAL_PG_IMAGE:-pgvector/pgvector:pg16}"
PORT="${P8S9_REHEARSAL_PG_PORT:-55490}"
NAME="p8s9-provider-rehearsal"
SUPERUSER="capiro"
SUPERPASS="capiro"
DB_NAME="capiro"
SERVE_LOGIN="p8s9_serve_rehearsal"
JOB_LOGIN="p8s9_job_rehearsal"
LOGIN_PASSWORD="p8s9-rehearsal-pw"
PASS_COUNT=0
log()  { echo "[p8s9-db-rehearsal] $*"; }
fail() { echo "[p8s9-db-rehearsal] FAILED: $*" >&2; exit 1; }
ok()   { PASS_COUNT=$((PASS_COUNT + 1)); echo "[p8s9-db-rehearsal]   ok  $*"; }

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
    docker exec "$NAME" pg_isready -h 127.0.0.1 -U "$SUPERUSER" -d "$DB_NAME" >/dev/null 2>&1 && break
    sleep 1
  done
  docker exec "$NAME" pg_isready -h 127.0.0.1 -U "$SUPERUSER" -d "$DB_NAME" >/dev/null 2>&1 \
    || fail "PostgreSQL did not become ready"
  REHEARSAL_DATABASE_URL="postgresql://$SUPERUSER:$SUPERPASS@localhost:$PORT/$DB_NAME"
fi
cleanup() {
  if [ "$SELF_MANAGED" = "1" ] && [ "${P8S9_REHEARSAL_KEEP:-0}" != "1" ]; then
    docker rm -f "$NAME" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [ "$SELF_MANAGED" = "1" ]; then
  unset PGSERVICE PGSERVICEFILE PGOPTIONS
  export PGHOSTADDR=127.0.0.1
fi

ADMIN=(psql --no-psqlrc "$REHEARSAL_DATABASE_URL" -v ON_ERROR_STOP=1 -q)
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
# Only the container created by this rehearsal receives a new role.
if [ "$SELF_MANAGED" = "1" ]; then
  run_sql "$(cat "$REPO_ROOT/scripts/ci/disposable-capiro-worker-role.sql")"
else
  [ "$(q "SELECT NOT (r.rolsuper OR r.rolinherit OR r.rolcreaterole OR r.rolcreatedb OR r.rolcanlogin OR r.rolreplication OR r.rolbypassrls) AND NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE r.oid IN (m.roleid,m.member)) FROM pg_roles r WHERE r.rolname='capiro_worker';")" = "t" ] \
    || fail "external rehearsal requires an existing safe capiro_worker prerequisite"
fi
ok "restricted worker prerequisite verified before migration replay"

run_sql "$(cat "$REPO_ROOT/docker/postgres/init/01-extensions.sql")"
ok "extensions bootstrapped"
(cd "$API_ROOT" && DATABASE_URL="$REHEARSAL_DATABASE_URL" npx prisma migrate deploy --schema prisma/schema.prisma >/dev/null) \
  || fail "migration-from-zero failed"
ok "full migration ledger including Session 9 applied cleanly"

[ "$(q "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='defense_provider_invocation';")" = "1" ] \
  || fail "defense_provider_invocation missing"
ok "the Session 9 provider invocation table exists"

log "2. Sessions 7 and 8 control planes are untouched"
for t in defense_budget_cycle defense_budget_expected_source defense_budget_source_observation \
         defense_budget_watcher_adapter defense_budget_watcher_run \
         defense_budget_ingestion_outbox defense_budget_lifecycle_signal \
         defense_budget_discovery_crawl defense_budget_discovery_candidate \
         defense_budget_discovery_host_budget; do
  [ "$(q "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='$t';")" = "1" ] \
    || fail "prior-session table $t missing after Session 9"
done
ok "all ten Session 7 and 8 tables still exist"

log "3. The provider audit declares no monetary or cost column"
MONEY="$(q "SELECT count(*) FROM information_schema.columns
  WHERE table_schema='public' AND table_name='defense_provider_invocation'
    AND (column_name ~* '(amount|usd|dollar|cost|price|spend|obligat|outlay)'
         OR data_type = 'money');")"
[ "$MONEY" = "0" ] || fail "provider audit declares $MONEY monetary/cost column(s)"
ok "no monetary or cost column exists (measured $MONEY)"

log "4. No column can hold a credential or a raw payload"
LEAKY="$(q "SELECT count(*) FROM information_schema.columns
  WHERE table_schema='public' AND table_name='defense_provider_invocation'
    AND column_name ~* '(secret|token|credential|password|api_?key|authorization|signature|vector|embedding|query)';")"
[ "$LEAKY" = "0" ] || fail "provider audit declares $LEAKY credential/payload column(s)"
ok "no credential or raw-payload column exists (measured $LEAKY)"

log "5. Create least-privilege rehearsal logins"
run_sql "DROP ROLE IF EXISTS $SERVE_LOGIN; CREATE ROLE $SERVE_LOGIN LOGIN PASSWORD '$LOGIN_PASSWORD';"
run_sql "DROP ROLE IF EXISTS $JOB_LOGIN; CREATE ROLE $JOB_LOGIN LOGIN PASSWORD '$LOGIN_PASSWORD';"
run_sql "GRANT capiro_defense_serve TO $SERVE_LOGIN WITH INHERIT TRUE;"
run_sql "GRANT capiro_defense_job TO $JOB_LOGIN WITH INHERIT TRUE;"
SERVE_URL="$(login_url "$SERVE_LOGIN")"
JOB_URL="$(login_url "$JOB_LOGIN")"
ok "serve/job rehearsal logins created"

INS="INSERT INTO defense_provider_invocation
  (provider, operation, outcome, model, tenant_id, payload_sha256, idempotency_key,
   attempts, latency_ms, failure_class, reason, result_dimension, result_count,
   started_at, finished_at)"

log "6. The serve role can record its own invocations"
# The provider calls happen on the HTTP read path, so serve is the only role that
# can record them. This is the one narrow grant Session 9 adds.
expect_ok "serve records a successful embedding" "$SERVE_URL" "$INS VALUES
  ('bedrock','embed_query','succeeded','amazon.titan-embed-text-v2:0','tenant-a',
   '$(hex64 a)','$(hex64 b)',1,42,NULL,'provider answered on attempt 1',1024,NULL,now(),now());"
expect_ok "serve records a degraded relevance call" "$SERVE_URL" "$INS VALUES
  ('main_api_internal','relevant_pe_codes','degraded_failed',NULL,'tenant-a',
   '$(hex64 c)','$(hex64 d)',3,3100,'throttled','provider throttled us',NULL,NULL,now(),now());"
expect_ok "job records an invocation too" "$JOB_URL" "$INS VALUES
  ('bedrock','embed_query','degraded_unconfigured',NULL,'tenant-a',
   '$(hex64 e)','$(hex64 f)',0,0,NULL,'no embedding provider configured',NULL,NULL,now(),now());"

log "7. A failure with no named class is unrepresentable"
expect_fail "a degraded_failed row with no failure class" "$SERVE_URL" "$INS VALUES
  ('bedrock','embed_query','degraded_failed',NULL,'t','$(hex64 1)','$(hex64 2)',
   3,100,NULL,'it just returned nothing',NULL,NULL,now(),now());"
expect_fail "a SUCCESS carrying a failure class" "$SERVE_URL" "$INS VALUES
  ('bedrock','embed_query','succeeded','m','t','$(hex64 3)','$(hex64 4)',
   1,10,'throttled','contradictory',8,NULL,now(),now());"

log "8. A degraded invocation cannot claim a result it never received"
expect_fail "a degraded row reporting an embedding dimension" "$SERVE_URL" "$INS VALUES
  ('bedrock','embed_query','degraded_unconfigured',NULL,'t','$(hex64 5)','$(hex64 6)',
   0,0,NULL,'unconfigured',1024,NULL,now(),now());"
expect_fail "a success that produced nothing" "$SERVE_URL" "$INS VALUES
  ('bedrock','embed_query','succeeded','m','t','$(hex64 7)','$(hex64 8)',
   1,10,NULL,'claims success with no result',NULL,NULL,now(),now());"

log "9. Operation and result shape must agree"
expect_fail "a relevance call carrying a model" "$SERVE_URL" "$INS VALUES
  ('main_api_internal','relevant_pe_codes','succeeded','some-model','t','$(hex64 9)','$(hex64 0)',
   1,10,NULL,'relevance has no model',NULL,4,now(),now());"
expect_fail "an embedding call carrying a result count" "$SERVE_URL" "$INS VALUES
  ('bedrock','embed_query','succeeded','m','t','$(hex64 2)','$(hex64 3)',
   1,10,NULL,'embedding has no count',8,4,now(),now());"
expect_fail "a relevance call reporting an embedding dimension" "$SERVE_URL" "$INS VALUES
  ('main_api_internal','relevant_pe_codes','succeeded',NULL,'t','$(hex64 4)','$(hex64 5)',
   1,10,NULL,'relevance has no dimension',8,NULL,now(),now());"

log "10. Every row must be coherent and attributable"
expect_fail "a row with a blank reason" "$SERVE_URL" "$INS VALUES
  ('bedrock','embed_query','degraded_unconfigured',NULL,'t','$(hex64 6)','$(hex64 7)',
   0,0,NULL,'   ',NULL,NULL,now(),now());"
expect_fail "a row with a blank tenant" "$SERVE_URL" "$INS VALUES
  ('bedrock','embed_query','degraded_unconfigured',NULL,'  ','$(hex64 8)','$(hex64 9)',
   0,0,NULL,'no tenant',NULL,NULL,now(),now());"
expect_fail "a row that finished before it started" "$SERVE_URL" "$INS VALUES
  ('bedrock','embed_query','degraded_unconfigured',NULL,'t','$(hex64 a)','$(hex64 c)',
   0,0,NULL,'time travel',NULL,NULL,now(),now() - interval '1 hour');"
expect_fail "a negative attempt count" "$SERVE_URL" "$INS VALUES
  ('bedrock','embed_query','degraded_unconfigured',NULL,'t','$(hex64 d)','$(hex64 e)',
   -1,0,NULL,'negative attempts',NULL,NULL,now(),now());"
expect_fail "a negative latency" "$SERVE_URL" "$INS VALUES
  ('bedrock','embed_query','degraded_unconfigured',NULL,'t','$(hex64 f)','$(hex64 1)',
   0,-5,NULL,'negative latency',NULL,NULL,now(),now());"
expect_fail "an unknown operation" "$SERVE_URL" "$INS VALUES
  ('bedrock','telepathy','succeeded',NULL,'t','$(hex64 2)','$(hex64 4)',
   1,10,NULL,'unknown op',NULL,1,now(),now());"
expect_fail "an unknown outcome" "$SERVE_URL" "$INS VALUES
  ('bedrock','embed_query','probably_fine','m','t','$(hex64 5)','$(hex64 6)',
   1,10,NULL,'unknown outcome',8,NULL,now(),now());"
expect_fail "a zero embedding dimension" "$SERVE_URL" "$INS VALUES
  ('bedrock','embed_query','succeeded','m','t','$(hex64 7)','$(hex64 8)',
   1,10,NULL,'empty vector',0,NULL,now(),now());"

log "11. The audit is append-only for BOTH roles"
expect_fail "serve updating an invocation" "$SERVE_URL" "UPDATE defense_provider_invocation SET reason='rewritten';"
expect_fail "serve deleting an invocation" "$SERVE_URL" "DELETE FROM defense_provider_invocation;"
expect_fail "job updating an invocation" "$JOB_URL" "UPDATE defense_provider_invocation SET attempts=0;"
expect_fail "job deleting an invocation" "$JOB_URL" "DELETE FROM defense_provider_invocation;"
expect_fail "serve running DDL on the audit" "$SERVE_URL" "ALTER TABLE defense_provider_invocation ADD COLUMN sneaky_cost_usd numeric;"

log "12. The serve grant is narrow: this table only"
# The whole justification for giving serve an INSERT is that it is the role on the
# read path. That must not have leaked into write access anywhere else.
expect_fail "serve writing a Session 7 control-plane table" "$SERVE_URL" "INSERT INTO defense_budget_cycle
  (fiscal_year, authority_track, template_version, bootstrap_origin, dedup_key)
  VALUES (2029,'authorization','defense_budget_cycle_template_v1','template','$(hex64 9)');"
expect_fail "serve writing the Session 8 discovery audit" "$SERVE_URL" "INSERT INTO defense_budget_discovery_crawl
  (adapter_id, run_key, request_url, resource_kind, status_code, status,
   effective_interval_ms, started_at, finished_at)
  VALUES ('govinfo-bills','x','https://www.govinfo.gov/a.xml','sitemap',200,'succeeded',1000,now(),now());"
# Serve already held write access to its OWN mutation surfaces from Sessions 2/3
# (watch, email-pref, data-issue, reconciliation queue, manual override, audit
# log). So the invariant is not "serve writes nothing else" — it is that Session 9
# widened that set by EXACTLY ONE table, INSERT-only. Pinning the whole set makes
# any future widening fail here rather than pass unnoticed.
EXPECTED_SERVE_WRITES="audit_logs
defense_budget_manual_override
defense_provider_invocation
pe_alert_email_pref
program_element_data_issue
program_element_watch
reconciliation_review_queue"
ACTUAL_SERVE_WRITES="$(q "SELECT DISTINCT table_name FROM information_schema.role_table_grants
  WHERE grantee='capiro_defense_serve'
    AND privilege_type IN ('INSERT','UPDATE','DELETE')
  ORDER BY table_name;")"
if [ "$ACTUAL_SERVE_WRITES" != "$EXPECTED_SERVE_WRITES" ]; then
  echo "[p8s9-db-rehearsal] expected serve write tables:" >&2
  echo "$EXPECTED_SERVE_WRITES" >&2
  echo "[p8s9-db-rehearsal] actual:" >&2
  echo "$ACTUAL_SERVE_WRITES" >&2
  fail "serve's write surface is not the Session 2/3 set plus the provider audit"
fi
ok "serve's write surface is exactly the prior set plus defense_provider_invocation"

# And on the new table it is INSERT only: an audit row must not be rewritable.
PROVIDER_PRIVS="$(q "SELECT string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type)
  FROM information_schema.role_table_grants
  WHERE grantee='capiro_defense_serve' AND table_name='defense_provider_invocation'
    AND privilege_type IN ('INSERT','UPDATE','DELETE');")"
[ "$PROVIDER_PRIVS" = "INSERT" ] \
  || fail "serve holds '$PROVIDER_PRIVS' on the provider audit; it must be INSERT only"
ok "serve holds INSERT and nothing else on the provider audit"

# No Session 7 or 8 table may be writable by serve.
CONTROL_PLANE_WRITES="$(q "SELECT count(*) FROM information_schema.role_table_grants
  WHERE grantee='capiro_defense_serve'
    AND privilege_type IN ('INSERT','UPDATE','DELETE')
    AND (table_name LIKE 'defense_budget_discovery%'
         OR table_name IN ('defense_budget_cycle','defense_budget_expected_source',
                           'defense_budget_source_observation','defense_budget_watcher_adapter',
                           'defense_budget_watcher_run','defense_budget_ingestion_outbox',
                           'defense_budget_lifecycle_signal'));")"
[ "$CONTROL_PLANE_WRITES" = "0" ] \
  || fail "serve gained $CONTROL_PLANE_WRITES write grant(s) on a Session 7/8 table"
ok "serve has no write grant on any Session 7 or 8 table (measured $CONTROL_PLANE_WRITES)"

log "13. Session 9 grants no promotion or snapshot-activation authority"
for tbl in defense_budget_promotion_run defense_budget_active_snapshot; do
  if [ "$(q "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='$tbl';")" = "1" ]; then
    expect_fail "serve writing $tbl" "$SERVE_URL" "INSERT INTO $tbl DEFAULT VALUES;"
    expect_fail "job writing $tbl" "$JOB_URL" "INSERT INTO $tbl DEFAULT VALUES;"
  fi
done
ok "no Session 9 role gained promotion or snapshot-activation authority"

log "14. The provider audit did not leak into ProgramElementYear"
LEAKS="$(q "SELECT count(*) FROM information_schema.columns
  WHERE table_name='program_element_year'
    AND column_name ~* '(provider|invocation|embedding|idempotency)';")"
[ "$LEAKS" = "0" ] || fail "provider columns leaked into program_element_year"
ok "ProgramElementYear is untouched by the provider runtime"

log "15. Both roles can read the audit for observability"
expect_ok "serve reads the invocation audit" "$SERVE_URL" "SELECT count(*) FROM defense_provider_invocation;"
expect_ok "job reads the invocation audit" "$JOB_URL" "SELECT count(*) FROM defense_provider_invocation;"

log "SESSION9_DB_REHEARSAL_PASS ($PASS_COUNT checks)"
