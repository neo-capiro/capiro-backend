#!/usr/bin/env bash
# Provision the DISPOSABLE databases the CleanUp1 gate's DB-backed suites need
# and apply each independent Prisma migration chain to the right database.
#
# The real current contract is:
#
#   - API, Intel and Workspace SHARE one database (`capiro`) and therefore ONE
#     `_prisma_migrations` ledger.  The intel-api recording / hearing specs
#     explicitly require the full API+Intel migration chains to coexist
#     (apps/intel-api/test/hearing-recording-postgres.spec.ts) and the aggregate
#     Workspace runtime specs exercise the ws_* tables through that same
#     connection, so the api, intel AND workspace chains are ALL applied to
#     `capiro` (api-first, then intel, then workspace).
#   - Workspace ALSO uses its OWN database (`capiro_workspace`) with its own
#     ledger, reached through WS_TEST_DATABASE_URL, so the workspace chain is
#     deployed there as well.
#
# The chains are therefore never mixed in one ledger beyond the shared
# api+intel+workspace set the specs actually require, and that shared set is
# exercised end to end by the suites themselves on a fresh checkout.
#
# Safety: mutating mode is restricted to GitHub Actions on the fixed loopback
# disposable service; no URL/host/port override is accepted. `--validate-only`
# prints the plan and touches nothing (safe locally).
set -euo pipefail

# Target identity. Defaults preserve the GitHub Actions disposable fixture
# exactly (postgres@127.0.0.1:5432). An OWNED, isolated disposable service (e.g.
# a task-owned pgvector16 container) may be targeted via explicit env overrides
# — but only together with CLEANUP1_OWNED_PG=1 AND a non-5432 port, so the
# host's unrelated 5432 database can never be touched (review round 4, item 3).
readonly PG_HOST="${CI_POSTGRES_HOST:-127.0.0.1}"
readonly PG_PORT="${CI_POSTGRES_PORT:-5432}"
readonly PG_ADMIN_ROLE="${CI_POSTGRES_USER:-postgres}"
readonly API_DB="${CI_POSTGRES_API_DB:-capiro}"
readonly INTEL_DB="${CI_POSTGRES_INTEL_DB:-capiro}"
readonly WORKSPACE_DB="${CI_POSTGRES_WORKSPACE_DB:-capiro_workspace}"
# Two API per-worker clones of the FULLY migrated shared template. The committed
# default Jest pool runs maxWorkers=2, and apps/api/jest.worker-database.cjs
# binds each real fork's inherited DATABASE_URL to its matching clone. The names
# are DERIVED from the selected API database as `<API_DB>_worker_<id>`; an
# explicit CI_POSTGRES_WORKER_DB_* override is accepted only when it is EXACTLY
# that canonical name (enforced below, before any DB action). They are created
# fresh from the shared template, closed, before any test starts.
readonly WORKER_DB_1="${CI_POSTGRES_WORKER_DB_1:-${API_DB}_worker_1}"
readonly WORKER_DB_2="${CI_POSTGRES_WORKER_DB_2:-${API_DB}_worker_2}"
# The port PostgreSQL itself reports (inet_server_port()). For a forwarded
# container (host 55460 -> container 5432) this is 5432 even though the connect
# port is 55460; the host's unrelated 5432 is protected by the CONNECT-port guard
# below, not by this value.
readonly PG_SERVER_PORT="${CI_POSTGRES_SERVER_PORT:-${PG_PORT}}"
readonly EXPECTED_IDENTITY="${PG_ADMIN_ROLE}|${PG_SERVER_PORT}|on"
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"

usage() {
  printf '%s\n' \
    'Usage: bootstrap-disposable-databases.sh [--validate-only]' \
    '' \
    'Creates the disposable databases and applies each Prisma migration chain:' \
    "  api       -> ${API_DB}" \
    "  intel     -> ${INTEL_DB} (intel specs require api+intel on one database)" \
    "  workspace -> ${API_DB} (shared api+intel database ALSO receives ws_* tables)" \
    "  workspace -> ${WORKSPACE_DB} (separate ledger, via WS_TEST_DATABASE_URL)" \
    "  worker    -> ${WORKER_DB_1}, ${WORKER_DB_2} (fresh closed API clones of the fully migrated ${API_DB} template)" \
    '' \
    "Worker clones are create-once: a preexisting ${WORKER_DB_1}/${WORKER_DB_2} that cannot be proved fresh is" \
    'refused (this script never drops or rewrites an existing worker database).' \
    '' \
    'Mutating mode requires GitHub Actions plus CI_DISPOSABLE_POSTGRES=1,' \
    'or an explicitly owned disposable service (CLEANUP1_OWNED_PG=1, non-5432).'
}

fail() {
  printf 'error: %s\n' "$1" >&2
  exit 2
}

# Loopback-only and exact-identifier guards (independent review round 5):
# a caller-set owned flag is NOT ownership evidence, and non-loopback hosts or
# loosely-matched identities are refused before any local mutation.
require_loopback_host() {
  case "$PG_HOST" in
    127.0.0.1|::1|localhost) : ;;
    *) fail "refusing non-loopback PostgreSQL host '$PG_HOST' (only 127.0.0.1/::1/localhost are permitted)" ;;
  esac
}

# A target database name must be a safe, unquoted identifier: no quotes, no
# shell metacharacters, no SQL injection into CREATE DATABASE / datname lookups.
safe_identifier() {
  [[ "$1" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]]
}

validate_database_names() {
  for db in "$API_DB" "$INTEL_DB" "$WORKSPACE_DB" "$WORKER_DB_1" "$WORKER_DB_2"; do
    safe_identifier "$db" || fail "unsafe database identifier '$db' (must match ^[A-Za-z_][A-Za-z0-9_]{0,62}$)"
  done
  [[ "$WORKER_DB_1" != "$WORKER_DB_2" ]] || fail "worker database names must be distinct ('$WORKER_DB_1')"
  # Worker names are fixed by the contract: exactly <API_DB>_worker_<id>. Any
  # override that disagrees is refused BEFORE any DB action, so a driver can
  # never bind worker 1/2 to a database the selected API base does not own.
  [[ "$WORKER_DB_1" == "${API_DB}_worker_1" ]] ||
    fail "worker database '$WORKER_DB_1' is inconsistent with the API database '$API_DB' (must be exactly ${API_DB}_worker_1)"
  [[ "$WORKER_DB_2" == "${API_DB}_worker_2" ]] ||
    fail "worker database '$WORKER_DB_2' is inconsistent with the API database '$API_DB' (must be exactly ${API_DB}_worker_2)"
  for w in "$WORKER_DB_1" "$WORKER_DB_2"; do
    [[ "$w" != "$API_DB" && "$w" != "$WORKSPACE_DB" ]] || fail "worker database '$w' must not equal a shared database name"
  done
}

# Prove the target port is published by the EXACT named task-owned container on
# loopback. Used only on the non-GitHub-Actions owned path. Review round 9: a
# grep for IP and port INDEPENDENTLY (accepting 0.0.0.0 and unrelated bindings)
# is not ownership. We validate ONE structured docker-inspect JSON object and
# require the container's exact Id, the exact ownership LABEL, and the SAME
# 5432/tcp binding entry to carry both the requested loopback HostIp AND the
# requested HostPort. A missing Id/label, a wrong Id/label, or an unrelated
# binding/any-interface match is refused.
require_owned_service_proof() {
  local container="${CLEANUP1_OWNED_CONTAINER:-}"
  local cid="${CLEANUP1_OWNED_CONTAINER_ID:-}"
  local label="${CLEANUP1_OWNED_LABEL:-}"
  [[ -n "$container" ]] || fail 'CLEANUP1_OWNED_PG=1 requires CLEANUP1_OWNED_CONTAINER naming the exact owned container (a flag alone is not ownership evidence)'
  [[ -n "$cid" ]] || fail 'CLEANUP1_OWNED_PG=1 requires CLEANUP1_OWNED_CONTAINER_ID (the exact created container id)'
  [[ -n "$label" ]] || fail 'CLEANUP1_OWNED_PG=1 requires CLEANUP1_OWNED_LABEL=key=value (the exact ownership label)'
  command -v docker >/dev/null 2>&1 || fail 'docker is required to prove owned-container ownership'
  command -v node >/dev/null 2>&1 || fail 'node is required to validate the structured docker-inspect JSON'
  local json
  json="$(docker inspect --format '{{json .}}' "$container" 2>/dev/null)" ||
    fail "owned container '$container' is not inspectable — cannot prove ownership"
  [[ -n "$json" ]] || fail "owned container '$container' inspect returned empty — cannot prove ownership"
  OWNED_INSPECT_JSON="$json" \
  PROOF_CONTAINER_ID="$cid" PROOF_LABEL="$label" \
  PROOF_HOST="$PG_HOST" PROOF_PORT="$PG_PORT" \
  node -e '
    const j = JSON.parse(process.env.OWNED_INSPECT_JSON);
    const fail = (m) => { process.stderr.write(`owned-proof: ${m}\n`); process.exit(2); };
    const id = String(j.Id || "");
    if (!/^[0-9a-f]{64}$/.test(id)) fail(`container Id is not a full 64-hex id (got ${JSON.stringify(j.Id)})`);
    if (id !== process.env.PROOF_CONTAINER_ID) fail(`container Id ${id} != supplied CLEANUP1_OWNED_CONTAINER_ID ${process.env.PROOF_CONTAINER_ID}`);
    const raw = String(process.env.PROOF_LABEL);
    const eq = raw.indexOf("=");
    if (eq <= 0) fail("CLEANUP1_OWNED_LABEL must be key=value");
    const lk = raw.slice(0, eq);
    const lv = raw.slice(eq + 1);           // keep the FULL remainder — never truncate a value containing '='
    if (!/^cleanup[.\-][A-Za-z0-9._-]+$/.test(lk)) fail(`ownership label key ${JSON.stringify(lk)} is not in the task-owned cleanup.* namespace`);
    const labels = (j.Config && j.Config.Labels) || {};
    if (labels[lk] !== lv) fail(`ownership label ${lk}=${JSON.stringify(labels[lk])} != ${JSON.stringify(lv)}`);
    const ports = (j.NetworkSettings && j.NetworkSettings.Ports) || {};
    const bindings = ports["5432/tcp"];
    if (!Array.isArray(bindings) || bindings.length === 0) fail("container publishes no 5432/tcp binding");
    const wantIp = process.env.PROOF_HOST, wantPort = String(process.env.PROOF_PORT);
    const m = bindings.find((b) => b && b.HostIp === wantIp && String(b.HostPort) === wantPort);
    if (!m) fail(`no single 5432/tcp binding entry matches HostIp=${wantIp} AND HostPort=${wantPort}`);
    process.stdout.write(`owned-proof ok id=${id.slice(0, 12)} binding=${wantIp}:${wantPort}\n`);
  '
}

VALIDATE_ONLY=0
while (($#)); do
  case "$1" in
    --validate-only) VALIDATE_ONLY=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "unknown argument '$1' (database URLs and target overrides are not accepted)" ;;
  esac
done

if ((VALIDATE_ONLY)); then
  printf 'validation-only: target=%s@%s:%s\n' "$PG_ADMIN_ROLE" "$PG_HOST" "$PG_PORT"
  printf 'validation-only: databases=%s,%s,%s\n' "$API_DB" "$INTEL_DB" "$WORKSPACE_DB"
  printf 'validation-only: worker-databases=%s,%s (cloned from %s)\n' "$WORKER_DB_1" "$WORKER_DB_2" "$API_DB"
  printf 'validation-only: chains api(intel)=%s workspace(shared)=%s workspace(separate)=%s\n' "$INTEL_DB" "$API_DB" "$WORKSPACE_DB"
  printf 'validation-only: no PostgreSQL command executed\n'
  exit 0
fi

[[ "${GITHUB_ACTIONS:-}" == true || "${CLEANUP1_OWNED_PG:-}" == 1 ]] || fail 'mutating mode is restricted to GitHub Actions (or an explicitly owned disposable service with CLEANUP1_OWNED_PG=1)'
[[ "${CI:-}" == true ]] || fail 'CI=true is required'
[[ "${CI_DISPOSABLE_POSTGRES:-}" == 1 ]] || fail 'CI_DISPOSABLE_POSTGRES=1 is required'
# Loopback + safe identifiers are enforced for EVERY mutating path.
require_loopback_host
validate_database_names
if [[ "${GITHUB_ACTIONS:-}" != true ]]; then
  # Owned-service path: never the host's unrelated 5432, and the owned flag is
  # backed by an EXACT container/port ownership proof.
  [[ "${PG_PORT}" != 5432 ]] || fail 'an owned non-GitHub-Actions proof must target a non-5432 disposable port'
  require_owned_service_proof
fi
command -v psql >/dev/null 2>&1 || fail 'psql is required on the GitHub Actions runner'

export PGPASSWORD="${CI_POSTGRES_PASSWORD:-postgres}"
readonly PSQL=(
  psql --no-psqlrc --set=ON_ERROR_STOP=1
  --host="$PG_HOST" --port="$PG_PORT" --username="$PG_ADMIN_ROLE" --dbname=postgres
)

run_psql() (
  unset PGSERVICE PGSERVICEFILE PGOPTIONS
  export PGHOST="$PG_HOST" PGHOSTADDR="$PG_HOST" PGPORT="$PG_PORT" PGUSER="$PG_ADMIN_ROLE"
  "${PSQL[@]}" "$@"
)

# Validate the connected server before any mutation (same guard as the roles
# bootstrap): fixed loopback disposable service, superuser admin.
connection_identity="$(run_psql --tuples-only --no-align --command \
  "SELECT current_user, inet_server_port(), current_setting('is_superuser')")"
[[ "$connection_identity" == "${EXPECTED_IDENTITY}" ]] ||
  fail "refusing unexpected PostgreSQL target identity '$connection_identity' (expected exactly '${EXPECTED_IDENTITY}')"

create_database() {
  local db="$1"
  if [[ "$(run_psql --tuples-only --no-align --command "SELECT 1 FROM pg_database WHERE datname='${db}'")" == '1' ]]; then
    printf 'database %s already exists\n' "$db"
  else
    printf 'creating database %s\n' "$db"
    run_psql --command "CREATE DATABASE \"${db}\""
  fi
}

create_database "$API_DB"
create_database "$WORKSPACE_DB"

url_for() { printf 'postgresql://%s:%s@%s:%s/%s' "$PG_ADMIN_ROLE" "${CI_POSTGRES_PASSWORD:-postgres}" "$PG_HOST" "$PG_PORT" "$1"; }

# Each deploy runs with an explicit per-service DATABASE_URL so the ledger each
# chain writes to is the one for its own database.
printf 'applying API migrations -> %s\n' "$API_DB"
DATABASE_URL="$(url_for "$API_DB")" pnpm --dir "$REPO_ROOT" --filter @capiro/api exec prisma migrate deploy

printf 'applying Intel migrations -> %s (api+intel coexist, required by intel specs)\n' "$INTEL_DB"
DATABASE_URL="$(url_for "$INTEL_DB")" pnpm --dir "$REPO_ROOT" --filter @capiro/intel-api exec prisma migrate deploy

# Workspace's ws_* tables must ALSO exist on the SHARED api+intel database: the
# aggregate Intel runtime specs exercise workspace tables through the same
# connection. This is the real Workspace migration chain (NOT db push / DDL
# fabrication), applied here in addition to the separate Workspace database.
printf 'applying Workspace migrations -> %s (shared api+intel database)\n' "$API_DB"
DATABASE_URL="$(url_for "$API_DB")" pnpm --dir "$REPO_ROOT" --filter @capiro/workspace exec prisma migrate deploy

printf 'applying Workspace migrations -> %s (separate Workspace database, own ledger)\n' "$WORKSPACE_DB"
DATABASE_URL="$(url_for "$WORKSPACE_DB")" pnpm --dir "$REPO_ROOT" --filter @capiro/workspace exec prisma migrate deploy

# Fresh, CLOSED API per-worker clones of the FULLY migrated shared template.
# Create-once on the dedicated clean service: a preexisting worker database is
# REFUSED (never dropped or rewritten) because its freshness/ownership cannot be
# proved here. Reruns therefore require the worker databases to be absent (a
# fresh service), which is the CI contract; the operator may drop them
# explicitly out-of-band, but this script will not.
create_worker_clone() {
  local worker_db="$1"
  if [[ "$(run_psql --tuples-only --no-align --command "SELECT 1 FROM pg_database WHERE datname='${worker_db}'")" == '1' ]]; then
    fail "worker database '${worker_db}' already exists; refusing to reuse or drop it — provision a fresh service (or remove it explicitly) and rerun"
  fi
  # CREATE DATABASE ... TEMPLATE requires the SOURCE template to have NO other
  # sessions attached, so verify the ACTUAL ${API_DB} template (not the absent
  # destination) reports zero active connections immediately before cloning.
  local template_active
  template_active="$(run_psql --tuples-only --no-align --command "SELECT count(*) FROM pg_stat_activity WHERE datname='${API_DB}'")"
  [[ "$template_active" == '0' ]] || fail "template database '${API_DB}' reports active connections before creating worker clone '${worker_db}'; refusing"
  printf 'creating worker clone %s TEMPLATE %s\n' "$worker_db" "$API_DB"
  run_psql --command "CREATE DATABASE \"${worker_db}\" TEMPLATE \"${API_DB}\""
  local ok
  ok="$(run_psql --tuples-only --no-align --command "SELECT 1 FROM pg_database WHERE datname='${worker_db}'")"
  [[ "$ok" == '1' ]] || fail "worker clone '${worker_db}' was not created"
}

create_worker_clone "$WORKER_DB_1"
create_worker_clone "$WORKER_DB_2"

printf 'ready: disposable databases, independent migration chains (workspace ALSO on shared %s) and %s/%s worker clones applied\n' \
  "$API_DB" "$WORKER_DB_1" "$WORKER_DB_2"
