#!/usr/bin/env bash
# Provision the three isolated Funding Opportunities CI databases.
#
# This script intentionally accepts only a loopback PostgreSQL admin URL and
# only the fixed database set below. It never drops, truncates, or resets a
# database. Run it from the repository root (or any directory): all paths are
# resolved relative to this script.
set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
readonly API_DIR="$REPO_ROOT/apps/api"
readonly FLAG_SCHEMA="$SCRIPT_DIR/intel-feature-flag-test-schema.sql"
readonly TEST_ROLE="fo_test"
readonly TEST_PASSWORD="fo_test_local"
readonly PG_HOST="127.0.0.1"
readonly PG_PORT="5486"
readonly TEST_DATABASES=(fo_v2_test fo_v2_search fo_v2_saved)

ADMIN_URL="${CI_POSTGRES_ADMIN_DATABASE_URL:-}"
VALIDATE_ONLY=0

usage() {
  printf '%s
' \
    'Usage: bootstrap-funding-opportunities-test-dbs.sh --admin-url URL [--validate-only]' \
    '' \
    'URL must target loopback 127.0.0.1:5486 with schema=public and database postgres or capiro' \
    '(postgresadmin is also accepted as the CI admin role). The script owns only' \
    'fo_v2_test, fo_v2_search, fo_v2_saved, plus the historical prerequisite capiro.'
}

fail() {
  printf 'error: %s\n' "$1" >&2
  exit 2
}

while (($#)); do
  case "$1" in
    --admin-url)
      (($# >= 2)) || fail '--admin-url requires a value'
      ADMIN_URL="$2"
      shift 2
      ;;
    --validate-only)
      VALIDATE_ONLY=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument '$1' (no arbitrary database target is accepted)"
      ;;
  esac
done

[[ -n "$ADMIN_URL" ]] || fail 'admin URL is required (--admin-url or CI_POSTGRES_ADMIN_DATABASE_URL)'

# Parse without contacting PostgreSQL. This is deliberately strict: a
# non-loopback URL, a non-CI port, an arbitrary admin role, or an arbitrary
# database name is rejected before any mutating command can run.
if [[ "$ADMIN_URL" =~ ^postgresql://([^:@/]+)(:[^@/]*)?@([^:/?]+):([0-9]+)/([^?]+)\?schema=public$ ]]; then
  ADMIN_ROLE="${BASH_REMATCH[1]}"
  ADMIN_PASSWORD_PART="${BASH_REMATCH[2]:-}"
  ADMIN_HOST="${BASH_REMATCH[3]}"
  ADMIN_PORT="${BASH_REMATCH[4]}"
  ADMIN_DATABASE="${BASH_REMATCH[5]}"
else
  fail 'admin URL must target loopback 127.0.0.1:5486 with schema=public and database postgres or capiro'
fi

case "$ADMIN_ROLE" in
  postgres|postgresadmin) ;;
  *) fail "admin role '$ADMIN_ROLE' is not allowed; use postgres or postgresadmin" ;;
esac
[[ "$ADMIN_HOST" == "$PG_HOST" ]] || fail "admin host must be $PG_HOST"
[[ "$ADMIN_PORT" == "$PG_PORT" ]] || fail "admin port must be $PG_PORT"
case "$ADMIN_DATABASE" in
  postgres|capiro) ;;
  *) fail "admin database '$ADMIN_DATABASE' is not allowed; use postgres or capiro" ;;
esac

for db in "${TEST_DATABASES[@]}"; do
  [[ "$db" != fo_v2_ca ]] || fail 'fo_v2_ca is never a bootstrap target'
done
[[ -f "$FLAG_SCHEMA" ]] || fail "missing checked-in dependency fixture: $FLAG_SCHEMA"
[[ -d "$API_DIR/prisma/migrations" ]] || fail "missing API migrations: $API_DIR/prisma/migrations"

# Prisma accepts the schema query parameter. libpq/psql does not reliably
# accept Prisma's `?schema=public`, so every psql invocation uses the exact
# same validated authority with that query stripped.
readonly ADMIN_AUTH="${ADMIN_ROLE}${ADMIN_PASSWORD_PART}@${PG_HOST}:${PG_PORT}"
readonly ADMIN_PSQL_URL="${ADMIN_URL%\?schema=public}"
admin_url_for() {
  printf 'postgresql://%s/%s?schema=public' "$ADMIN_AUTH" "$1"
}
psql_url_for() {
  printf 'postgresql://%s/%s' "$ADMIN_AUTH" "$1"
}

test_url_for() {
  printf '%s' 'postgresql://' "$TEST_ROLE" ':' "$TEST_PASSWORD" '@' "$PG_HOST" ':' "$PG_PORT" '/' "$1" '?schema=public'
}

if ((VALIDATE_ONLY)); then
  printf 'validation-only: admin=%s@%s:%s/%s\n' "$ADMIN_ROLE" "$ADMIN_HOST" "$ADMIN_PORT" "$ADMIN_DATABASE"
  printf 'validation-only: targets=%s\n' "${TEST_DATABASES[*]}"
  printf 'validation-only: API migration files=%s\n' "$(find "$API_DIR/prisma/migrations" -mindepth 2 -maxdepth 2 -name migration.sql -type f | wc -l | tr -d ' ')"
  printf 'validation-only: psql query stripped from validated admin URL\n'
  printf 'validation-only: no PostgreSQL command executed\n'
  exit 0
fi

command -v psql >/dev/null 2>&1 || fail 'psql is required on the CI runner'
command -v pnpm >/dev/null 2>&1 || fail 'pnpm is required on the CI runner'

# psql is always told to stop on the first SQL error. No command below drops
# or resets an existing object.
admin_psql() {
  psql --no-psqlrc --set=ON_ERROR_STOP=1 "$ADMIN_PSQL_URL" "$@"
}
target_psql() {
  local db="$1"
  shift
  psql --no-psqlrc --set=ON_ERROR_STOP=1 "$(psql_url_for "$db")" "$@"
}

printf 'Ensuring CI role %s and historical migration prerequisite database capiro exist...\n' "$TEST_ROLE"
admin_psql <<'SQL'
DO $bootstrap$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fo_test') THEN
    IF NOT (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'fo_test') THEN
      RAISE EXCEPTION 'existing fo_test role cannot login';
    END IF;
  ELSE
    -- Fixed CI-only credentials; no user-controlled value is interpolated.
    CREATE ROLE fo_test LOGIN PASSWORD 'fo_test_local';
  END IF;
END
$bootstrap$;
SQL
# The fixed CI role uses BYPASSRLS because the current real persistence
# fixtures seed rows as fo_test outside request-local withTenant/withSystem
# context. This is deliberately not an RLS-role-isolation claim; application
# guards and service-context checks remain the release evidence here.
admin_psql -c 'ALTER ROLE "fo_test" LOGIN PASSWORD '\''fo_test_local'\'' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS;'

ensure_database() {
  local db="$1"
  local exists
  exists="$(admin_psql -Atc "SELECT 1 FROM pg_database WHERE datname = '$db'")"
  if [[ "$exists" != 1 ]]; then
    admin_psql -c "CREATE DATABASE \"$db\" OWNER \"$TEST_ROLE\";"
    printf 'created database %s\n' "$db"
  else
    printf 'preserving existing database %s\n' "$db"
  fi
}

ensure_database capiro
for db in "${TEST_DATABASES[@]}"; do
  ensure_database "$db"
done

for db in "${TEST_DATABASES[@]}"; do
  target_url="$(admin_url_for "$db")"
  printf 'Applying API migrations to %s (DATABASE_URL uses validated CI admin authority)...\n' "$db"
  (cd "$API_DIR" && DATABASE_URL="$target_url" FUNDING_OPPORTUNITIES_TEST_DATABASE_URL="$(test_url_for "$db")" pnpm exec prisma migrate deploy)

  # Tests connect as fo_test. Existing databases are preserved, while grants
  # make reruns useful even when a prior run used a different owner.
  target_psql "$db" -c "GRANT CONNECT ON DATABASE \"$db\" TO \"$TEST_ROLE\"; GRANT USAGE ON SCHEMA public TO \"$TEST_ROLE\"; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO \"$TEST_ROLE\"; GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO \"$TEST_ROLE\"; ALTER DEFAULT PRIVILEGES GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO \"$TEST_ROLE\"; ALTER DEFAULT PRIVILEGES GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO \"$TEST_ROLE\";"
  target_psql "$db" -f "$FLAG_SCHEMA"
  target_psql "$db" -c "GRANT SELECT, INSERT, UPDATE, DELETE ON \"intel_feature_flag\" TO \"$TEST_ROLE\";"
  printf 'ready: %s => DATABASE_URL and FUNDING_OPPORTUNITIES_TEST_DATABASE_URL must both be %s\n' "$db" "$(test_url_for "$db")"
done

printf 'bootstrap complete: %s\n' "${TEST_DATABASES[*]}"
