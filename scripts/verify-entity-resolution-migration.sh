#!/usr/bin/env bash
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS=(
  "$ROOT/apps/api/prisma/migrations/20261120100000_universal_entity_resolution/migration.sql"
  "$ROOT/apps/api/prisma/migrations/20261120110000_universal_entity_resolution_hardening/migration.sql"
  "$ROOT/apps/api/prisma/migrations/20261120120000_canonical_entity_merge_ledger/migration.sql"
  "$ROOT/apps/api/prisma/migrations/20261120130000_canonical_entity_terminal_lifecycle/migration.sql"
)

T1=11111111-1111-4111-8111-111111111111
T2=22222222-2222-4222-8222-222222222222
GORG=33333333-3333-4333-8333-333333333333
P1=44444444-4444-4444-8444-444444444444
P2=55555555-5555-4555-8555-555555555555
GPER=66666666-6666-4666-8666-666666666666
R1=77777777-7777-4777-8777-777777777777
R2=88888888-8888-4888-8888-888888888888
ACTOR=99999999-9999-4999-8999-999999999999

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
  ('$GORG',NULL,'global_public','organization','RTX Corporation','rtx corporation','active',1,'uei_exact'),
  ('$P1','$T1','tenant_private','organization','Tenant RTX','tenant rtx','active',1,'crm_client'),
  ('$P2','$T2','tenant_private','organization','Other Private','other private','active',1,'crm_client'),
  ('$GPER',NULL,'global_public','person','Jane Public','jane public','active',1,'directory_exact');
INSERT INTO entity_aliases
  (entity_id,tenant_id,identity_scope,alias,normalized_alias,source_type,source_id,confidence,status)
VALUES
  ('$GORG',NULL,'global_public','Raytheon Technologies','raytheon technologies','sec_filing','0000101829',1,'active'),
  ('$GORG','$T1','tenant_private','Our RTX account','our rtx account','crm_client','client-one',1,'active'),
  ('$P2','$T2','tenant_private','Private Co','private co','crm_client','client-two',1,'active');
INSERT INTO entity_identifiers
  (entity_id,tenant_id,identity_scope,identifier_type,identifier_value,normalized_value,source_type,source_id,confidence,status)
VALUES
  ('$GORG',NULL,'global_public','uei','ABCDEF123456','ABCDEF123456','sam_entity','ABCDEF123456',1,'active'),
  ('$GORG','$T1','tenant_private','crm_client_id','client-42','CLIENT42','crm_client','client-42',1,'active'),
  ('$P2','$T2','tenant_private','crm_client_id','client-42','CLIENT42','crm_client','client-42',1,'active');
INSERT INTO entity_resolutions
  (id,tenant_id,idempotency_key,actor_user_id,raw_input,normalized_input,entity_type_hint,candidate_entity_ids,selected_entity_id,status,confidence,resolution_method,provenance)
VALUES
  ('$R1','$T1',repeat('1',64),'$ACTOR','RTX','rtx','organization',jsonb_build_array('$GORG'),'$GORG','resolved',1,'identifier_exact','[]');
SQL

expect_fail_sql "cross-tenant candidate unexpectedly committed" \
  "INSERT INTO entity_resolutions(tenant_id,idempotency_key,raw_input,normalized_input,entity_type_hint,candidate_entity_ids,status,confidence,resolution_method,provenance) VALUES('$T1',repeat('2',64),'Private','private','organization',jsonb_build_array('$P2'),'unresolved',0,'unresolved','[]')"
expect_fail_sql "selected entity outside candidate list unexpectedly committed" \
  "INSERT INTO entity_resolutions(tenant_id,idempotency_key,raw_input,normalized_input,entity_type_hint,candidate_entity_ids,selected_entity_id,status,confidence,resolution_method,provenance) VALUES('$T1',repeat('3',64),'RTX','rtx','organization',jsonb_build_array('$P1'),'$GORG','resolved',1,'user_selected','[]')"
expect_fail_sql "one-candidate ambiguous resolution unexpectedly committed" \
  "INSERT INTO entity_resolutions(tenant_id,idempotency_key,raw_input,normalized_input,entity_type_hint,candidate_entity_ids,status,confidence,resolution_method,provenance) VALUES('$T1',repeat('4',64),'RTX','rtx','organization',jsonb_build_array('$GORG'),'ambiguous',.9,'multiple_exact_candidates','[]')"
expect_fail_sql "correction query drift unexpectedly committed" \
  "INSERT INTO entity_resolutions(tenant_id,idempotency_key,actor_user_id,raw_input,normalized_input,entity_type_hint,candidate_entity_ids,selected_entity_id,status,confidence,resolution_method,provenance,correction_of_resolution_id) VALUES('$T1',repeat('5',64),'$ACTOR','Different','different','organization',jsonb_build_array('$GORG'),'$GORG','corrected',1,'user_corrected','[]','$R1')"

psql_cmd -c "INSERT INTO entity_resolutions(id,tenant_id,idempotency_key,actor_user_id,raw_input,normalized_input,entity_type_hint,candidate_entity_ids,selected_entity_id,status,confidence,resolution_method,provenance,correction_of_resolution_id) VALUES('$R2','$T1',repeat('6',64),'$ACTOR','RTX','rtx','organization',jsonb_build_array('$GORG','$P1'),'$GORG','corrected',1,'user_corrected','[]','$R1')"
expect_fail_sql "immutable entity resolution unexpectedly updated" "UPDATE entity_resolutions SET confidence=.5 WHERE id='$R1'"
expect_fail_sql "immutable entity resolution unexpectedly deleted" "DELETE FROM entity_resolutions WHERE id='$R1'"
expect_fail_sql "cross-tenant alias unexpectedly committed" \
  "INSERT INTO entity_aliases(entity_id,tenant_id,identity_scope,alias,normalized_alias,source_type,confidence,status) VALUES('$P2','$T1','tenant_private','Leak','leak','crm_client',1,'active')"
expect_fail_sql "alias provenance unexpectedly mutated" "UPDATE entity_aliases SET source_id='rewritten' WHERE tenant_id='$T1' AND normalized_alias='our rtx account'"
expect_fail_sql "identifier identity unexpectedly mutated" "UPDATE entity_identifiers SET normalized_value='DIFFERENT' WHERE tenant_id='$T1' AND identifier_type='crm_client_id'"
expect_fail_sql "duplicate global identifier unexpectedly committed" \
  "INSERT INTO entity_identifiers(entity_id,identity_scope,identifier_type,identifier_value,normalized_value,source_type,confidence,status) VALUES('$GPER','global_public','uei','ABCDEF123456','ABCDEF123456','sam_entity',1,'active')"
expect_fail_sql "duplicate tenant identifier unexpectedly committed" \
  "INSERT INTO entity_identifiers(entity_id,tenant_id,identity_scope,identifier_type,identifier_value,normalized_value,source_type,confidence,status) VALUES('$P1','$T1','tenant_private','crm_client_id','client-42','CLIENT42','crm_client',1,'active')"
expect_fail_sql "canonical entity scope unexpectedly mutated" "UPDATE canonical_entities SET identity_scope='global_public',tenant_id=NULL WHERE id='$P1'"
expect_fail_sql "cross-type merge unexpectedly committed" \
  "INSERT INTO canonical_entity_merges(tenant_id,source_entity_id,target_entity_id,reason_code,provenance) VALUES('$T1','$P1','$GPER','confirmed_public_mapping','[]')"
expect_fail_sql "cross-tenant merge unexpectedly committed" \
  "INSERT INTO canonical_entity_merges(tenant_id,source_entity_id,target_entity_id,reason_code,provenance) VALUES('$T1','$P1','$P2','confirmed_public_mapping','[]')"
expect_fail_sql "merge without lineage unexpectedly committed" "UPDATE canonical_entities SET status='merged',merged_into_entity_id='$GORG' WHERE id='$P1'"

psql_cmd <<SQL
BEGIN;
INSERT INTO canonical_entity_merges
  (tenant_id,source_entity_id,target_entity_id,actor_user_id,reason_code,reason,provenance)
VALUES ('$T1','$P1','$GORG','$ACTOR','confirmed_public_mapping','Reviewed exact UEI','[]');
UPDATE canonical_entities SET status='merged',merged_into_entity_id='$GORG' WHERE id='$P1';
COMMIT;
SQL
expect_fail_sql "immutable merge lineage unexpectedly updated" "UPDATE canonical_entity_merges SET reason='rewritten' WHERE source_entity_id='$P1'"
expect_fail_sql "immutable merge lineage unexpectedly deleted" "DELETE FROM canonical_entity_merges WHERE source_entity_id='$P1'"
expect_fail_sql "terminal merged entity unexpectedly reopened" "UPDATE canonical_entities SET status='active',merged_into_entity_id=NULL WHERE id='$P1'"

psql_cmd -c "UPDATE entity_aliases SET status='withdrawn' WHERE tenant_id='$T1' AND normalized_alias='our rtx account'; UPDATE entity_identifiers SET status='withdrawn' WHERE tenant_id='$T1' AND identifier_type='crm_client_id'"
expect_fail_sql "withdrawn alias unexpectedly reactivated" "UPDATE entity_aliases SET status='active' WHERE tenant_id='$T1' AND normalized_alias='our rtx account'"
expect_fail_sql "withdrawn identifier unexpectedly reactivated" "UPDATE entity_identifiers SET status='active' WHERE tenant_id='$T1' AND identifier_type='crm_client_id'"
expect_fail_sql "tenant session unexpectedly created a global entity" \
  "SET ROLE capiro_app; SELECT set_config('app.current_tenant','$T1',false); INSERT INTO canonical_entities(identity_scope,entity_type,canonical_name,normalized_name,resolution_confidence,resolution_method) VALUES('global_public','organization','Unauthorized','unauthorized',1,'manual')"

psql_cmd <<SQL
SET ROLE capiro_app;
SELECT set_config('app.current_tenant','$T1',false);
DO \$\$
DECLARE e int; a int; i int; r int; m int;
BEGIN
  SELECT count(*) INTO e FROM canonical_entities;
  SELECT count(*) INTO a FROM entity_aliases;
  SELECT count(*) INTO i FROM entity_identifiers;
  SELECT count(*) INTO r FROM entity_resolutions;
  SELECT count(*) INTO m FROM canonical_entity_merges;
  IF e<>3 OR a<>2 OR i<>2 OR r<>2 OR m<>1 THEN
    RAISE EXCEPTION 'RLS visibility failed: entities %, aliases %, identifiers %, resolutions %, merges %',e,a,i,r,m;
  END IF;
END
\$\$;
RESET ROLE;
SQL

echo "Knowledge Plane Phase 5 Universal Entity Resolution PostgreSQL rehearsal passed."
