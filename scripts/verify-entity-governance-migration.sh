#!/usr/bin/env bash
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS=(
  "$ROOT/apps/api/prisma/migrations/20261120100000_universal_entity_resolution/migration.sql"
  "$ROOT/apps/api/prisma/migrations/20261120110000_universal_entity_resolution_hardening/migration.sql"
  "$ROOT/apps/api/prisma/migrations/20261120120000_canonical_entity_merge_ledger/migration.sql"
  "$ROOT/apps/api/prisma/migrations/20261120130000_canonical_entity_terminal_lifecycle/migration.sql"
  "$ROOT/apps/api/prisma/migrations/20261120140000_entity_identity_governance/migration.sql"
  "$ROOT/apps/api/prisma/migrations/20261120141000_entity_governance_concurrency/migration.sql"
  "$ROOT/apps/api/prisma/migrations/20261120142000_resolution_governance_projection/migration.sql"
)

T1=11111111-1111-4111-8111-111111111111
T2=22222222-2222-4222-8222-222222222222
ENTITY1=33333333-3333-4333-8333-333333333333
ENTITY2=44444444-4444-4444-8444-444444444444
ALIAS1=55555555-5555-4555-8555-555555555555
IDENTIFIER1=66666666-6666-4666-8666-666666666666
RESOLUTION1=77777777-7777-4777-8777-777777777777
ACTOR=88888888-8888-4888-8888-888888888888

psql_cmd() { psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 "$@"; }
expect_fail_sql() {
  local label="$1" sql="$2"
  if psql_cmd -c "$sql" >/dev/null 2>&1; then
    echo "ERROR: $label" >&2
    exit 1
  fi
}

psql_cmd <<'SQL'
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO public;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;
DO $$ BEGIN CREATE ROLE capiro_app NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT USAGE ON SCHEMA public TO capiro_app;
CREATE TABLE tenants (id UUID PRIMARY KEY);
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS UUID LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_tenant', true), '')::uuid
$$;
CREATE OR REPLACE FUNCTION rls_bypass() RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
$$;
SQL
for migration in "${MIGRATIONS[@]}"; do psql_cmd -f "$migration"; done

psql_cmd <<SQL
INSERT INTO tenants(id) VALUES ('$T1'),('$T2');
INSERT INTO canonical_entities
  (id,tenant_id,identity_scope,entity_type,canonical_name,normalized_name,status,resolution_confidence,resolution_method)
VALUES
  ('$ENTITY1','$T1','tenant_private','organization','Tenant One Co','tenant one co','active',1,'crm_client'),
  ('$ENTITY2','$T2','tenant_private','organization','Tenant Two Co','tenant two co','active',1,'crm_client');
INSERT INTO entity_aliases
  (id,entity_id,tenant_id,identity_scope,alias,normalized_alias,source_type,source_id,confidence,status)
VALUES
  ('$ALIAS1','$ENTITY1','$T1','tenant_private','Our Account','our account','crm_client','client-1',.75,'active');
INSERT INTO entity_identifiers
  (id,entity_id,tenant_id,identity_scope,identifier_type,identifier_value,normalized_value,source_type,source_id,confidence,status)
VALUES
  ('$IDENTIFIER1','$ENTITY1','$T1','tenant_private','crm_client_id','client-1','CLIENT1','crm_client','client-1',.75,'active');
INSERT INTO entity_resolutions
  (id,tenant_id,idempotency_key,raw_input,normalized_input,entity_type_hint,candidate_entity_ids,status,confidence,resolution_method,provenance)
VALUES
  ('$RESOLUTION1','$T1',repeat('1',64),'Tenant One','tenant one','organization',jsonb_build_array('$ENTITY1'),'unresolved',0,'unresolved','[]');
SQL

expect_fail_sql "application role unexpectedly updated alias directly" \
  "SET ROLE capiro_app; SELECT set_config('app.current_tenant','$T1',false); UPDATE entity_aliases SET confidence=1 WHERE id='$ALIAS1'"
expect_fail_sql "application role unexpectedly updated identifier directly" \
  "SET ROLE capiro_app; SELECT set_config('app.current_tenant','$T1',false); UPDATE entity_identifiers SET confidence=1 WHERE id='$IDENTIFIER1'"

psql_cmd <<SQL
SET ROLE capiro_app;
SELECT set_config('app.current_tenant','$T1',false);
SELECT govern_entity_alias(
  '$T1','$ALIAS1','confirm','$ACTOR','user_confirmed','Verified in CRM',repeat('a',64)
);
SELECT govern_entity_identifier(
  '$T1','$IDENTIFIER1','confirm','$ACTOR','user_confirmed','Verified in CRM',repeat('b',64)
);
RESET ROLE;
SQL

psql_cmd <<SQL
DO \$\$
DECLARE alias_confidence numeric; identifier_confidence numeric; event_count int;
BEGIN
  SELECT confidence INTO alias_confidence FROM entity_aliases WHERE id='$ALIAS1';
  SELECT confidence INTO identifier_confidence FROM entity_identifiers WHERE id='$IDENTIFIER1';
  SELECT count(*) INTO event_count
  FROM entity_identity_governance_events
  WHERE tenant_id='$T1';
  IF alias_confidence <> 1 OR identifier_confidence <> 1 OR event_count <> 2 THEN
    RAISE EXCEPTION 'governed confirmation failed: alias %, identifier %, events %',
      alias_confidence, identifier_confidence, event_count;
  END IF;
END
\$\$;
SQL

psql_cmd <<SQL
SET ROLE capiro_app;
SELECT set_config('app.current_tenant','$T1',false);
SELECT govern_entity_alias(
  '$T1','$ALIAS1','confirm','$ACTOR','user_confirmed','Verified in CRM',repeat('a',64)
);
RESET ROLE;
DO \$\$
DECLARE event_count int;
BEGIN
  SELECT count(*) INTO event_count
  FROM entity_identity_governance_events
  WHERE tenant_id='$T1' AND idempotency_key=repeat('a',64);
  IF event_count <> 1 THEN RAISE EXCEPTION 'governance replay was not idempotent'; END IF;
END
\$\$;
SQL

expect_fail_sql "cross-tenant alias governance unexpectedly succeeded" \
  "SET ROLE capiro_app; SELECT set_config('app.current_tenant','$T2',false); SELECT govern_entity_alias('$T1','$ALIAS1','withdraw','$ACTOR','incorrect_identity',NULL,repeat('c',64))"

psql_cmd <<SQL
SET ROLE capiro_app;
SELECT set_config('app.current_tenant','$T1',false);
SELECT govern_entity_alias(
  '$T1','$ALIAS1','withdraw','$ACTOR','stale_source','No longer valid',repeat('d',64)
);
SELECT govern_entity_identifier(
  '$T1','$IDENTIFIER1','withdraw','$ACTOR','privacy_request','Remove private mapping',repeat('e',64)
);
RESET ROLE;
SQL
expect_fail_sql "withdrawn alias unexpectedly governed again" \
  "SET ROLE capiro_app; SELECT set_config('app.current_tenant','$T1',false); SELECT govern_entity_alias('$T1','$ALIAS1','confirm','$ACTOR','user_confirmed',NULL,repeat('f',64))"
expect_fail_sql "withdrawn identifier unexpectedly governed again" \
  "SET ROLE capiro_app; SELECT set_config('app.current_tenant','$T1',false); SELECT govern_entity_identifier('$T1','$IDENTIFIER1','confirm','$ACTOR','user_confirmed',NULL,repeat('0',64))"

expect_fail_sql "governance event unexpectedly updated" \
  "UPDATE entity_identity_governance_events SET reason='rewritten' WHERE tenant_id='$T1'"
expect_fail_sql "governance event unexpectedly deleted" \
  "DELETE FROM entity_identity_governance_events WHERE tenant_id='$T1'"

psql_cmd <<SQL
SET ROLE capiro_app;
SELECT set_config('app.current_tenant','$T1',false);
DO \$\$
DECLARE visible int;
BEGIN
  SELECT count(*) INTO visible FROM entity_identity_governance_events;
  IF visible <> 4 THEN
    RAISE EXCEPTION 'governance event RLS failed: visible %', visible;
  END IF;
END
\$\$;
RESET ROLE;
SQL

echo "Knowledge Plane Phase 5 entity governance PostgreSQL rehearsal passed."
