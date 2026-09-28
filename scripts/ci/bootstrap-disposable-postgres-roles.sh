#!/usr/bin/env bash
# Create external baseline prerequisites that production already provisions,
# but a clean GitHub Actions PostgreSQL service does not. This helper is
# intentionally tied to the repository's disposable capiro service fixture: it
# accepts no database URL or target override and refuses to mutate outside GHA.
set -euo pipefail

readonly PG_HOST="127.0.0.1"
readonly PG_PORT="5432"
readonly PG_DATABASE="capiro"
readonly PG_ADMIN_ROLE="postgres"
readonly REQUIRED_ROLE="capiro_worker"
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly APPEND_ONLY_PREREQUISITE_SQL="${SCRIPT_DIR}/research-portfolio-append-only-prerequisite.sql"

usage() {
  printf '%s\n' \
    'Usage: bootstrap-disposable-postgres-roles.sh [--validate-only]' \
    '' \
    'Mutating mode requires GitHub Actions plus CI_DISPOSABLE_POSTGRES=1.' \
    'The only target is postgres@127.0.0.1:5432/capiro; URLs and target overrides are rejected.'
}

fail() {
  printf 'error: %s\n' "$1" >&2
  exit 2
}

VALIDATE_ONLY=0
while (($#)); do
  case "$1" in
    --validate-only)
      VALIDATE_ONLY=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument '$1' (database URLs and target overrides are not accepted)"
      ;;
  esac
done

if ((VALIDATE_ONLY)); then
  printf 'validation-only: target=%s@%s:%s/%s\n' \
    "$PG_ADMIN_ROLE" "$PG_HOST" "$PG_PORT" "$PG_DATABASE"
  printf 'validation-only: required role=%s NOLOGIN NOINHERIT NOBYPASSRLS\n' "$REQUIRED_ROLE"
  printf 'validation-only: append-only prerequisite=%s\n' "$APPEND_ONLY_PREREQUISITE_SQL"
  printf 'validation-only: no PostgreSQL command executed\n'
  exit 0
fi

[[ "${GITHUB_ACTIONS:-}" == true ]] || fail 'mutating mode is restricted to GitHub Actions'
[[ "${CI:-}" == true ]] || fail 'CI=true is required'
[[ "${CI_DISPOSABLE_POSTGRES:-}" == 1 ]] || fail 'CI_DISPOSABLE_POSTGRES=1 is required'
command -v psql >/dev/null 2>&1 || fail 'psql is required on the GitHub Actions runner'

export PGPASSWORD="${CI_POSTGRES_PASSWORD:-postgres}"
readonly PSQL=(
  psql
  --no-psqlrc
  --set=ON_ERROR_STOP=1
  --host="$PG_HOST"
  --port="$PG_PORT"
  --username="$PG_ADMIN_ROLE"
  --dbname="$PG_DATABASE"
)

run_psql() (
  # Command-line --host does not override an inherited PGHOSTADDR, and libpq
  # services can supply their own connection parameters. Pin both address
  # inputs and remove service/option expansion for every psql invocation.
  unset PGSERVICE PGSERVICEFILE PGOPTIONS
  export PGHOST="$PG_HOST"
  export PGHOSTADDR="$PG_HOST"
  export PGPORT="$PG_PORT"
  export PGDATABASE="$PG_DATABASE"
  export PGUSER="$PG_ADMIN_ROLE"
  "${PSQL[@]}" "$@"
)

# Validate the connected server before any mutation. The fixed loopback TCP
# endpoint, database, service superuser, and GHA-only marker distinguish this
# disposable fixture from an arbitrary DATABASE_URL (including capiro-dev or
# any other live database). inet_server_addr() is intentionally not compared:
# Docker port forwarding exposes the container's bridge address to Postgres.
connection_identity="$(run_psql --tuples-only --no-align --command \
  "SELECT current_database(), current_user, inet_server_port(), current_setting('is_superuser')")"
[[ "$connection_identity" == 'capiro|postgres|5432|on' ]] ||
  fail "refusing unexpected PostgreSQL target identity '$connection_identity'"

run_psql <<'SQL'
DO $bootstrap$
DECLARE
  role_is_safe boolean;
  role_has_memberships boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_worker') THEN
    CREATE ROLE capiro_worker
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
  ELSE
    SELECT NOT (
      rolsuper OR rolinherit OR rolcreaterole OR rolcreatedb OR rolcanlogin OR
      rolreplication OR rolbypassrls
    )
    INTO role_is_safe
    FROM pg_roles
    WHERE rolname = 'capiro_worker';

    SELECT EXISTS (
      SELECT 1
      FROM pg_auth_members memberships
      JOIN pg_roles fixture_role
        ON fixture_role.oid IN (memberships.roleid, memberships.member)
      WHERE fixture_role.rolname = 'capiro_worker'
    )
    INTO role_has_memberships;

    IF NOT role_is_safe OR role_has_memberships THEN
      RAISE EXCEPTION
        'existing capiro_worker role is not the expected least-privilege CI fixture';
    END IF;
  END IF;
END
$bootstrap$;
SQL

run_psql --file="$APPEND_ONLY_PREREQUISITE_SQL"

printf 'ready: disposable migration prerequisites (role %s and append-only function)\n' \
  "$REQUIRED_ROLE"
