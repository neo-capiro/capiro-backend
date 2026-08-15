#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PHASE5_MIGRATION="$ROOT_DIR/apps/api/prisma/migrations/20261120100000_universal_entity_resolution/migration.sql"
HARDENING_MIGRATION="$ROOT_DIR/apps/api/prisma/migrations/20261120110000_universal_entity_resolution_hardening/migration.sql"

TENANT_ONE="11111111-1111-4111-8111-111111111111"
TENANT_TWO="22222222-2222-4222-8222-222222222222"
GLOBAL_ORG="33333333-3333-4333-8333-333333333333"
TENANT_ONE_ORG="44444444-4444-4444-8444-444444444444"
TENANT_TWO_ORG="55555555-5555-4555-8555-555555555555"
GLOBAL_PERSON="66666666-6666-4666-8666-666666666666"
RESOLUTION_ONE="77777777-7777-4777-8777-777777777777"
RESOLUTION_CORRECTION="88888888-8888-4888-8888-888888888888"
ACTOR_ONE="99999999-9999-4999-8999-999999999999"

psql_cmd() {
  psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 "$@"
}

psql_cmd <<SQL
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO public;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;

DO \$\$
BEGIN
  CREATE ROLE capiro_app NOLOGIN;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
\$\$;
GRANT USAGE ON SCHEMA public TO capiro_app;

CREATE TABLE tenants (
  id UUID PRIMARY KEY
);

CREATE OR REPLACE FUNCTION current_tenant_id()
RETURNS UUID
LANGUAGE sql
STABLE
AS \$\$
  SELECT NULLIF(current_setting('app.current_tenant', true), '')::uuid
\$\$;

CREATE OR REPLACE FUNCTION rls_bypass()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS \$\$
  SELECT COALESCE(current_setting('app.bypass_rls', true), '') = 'on'
\$\$;
SQL

psql_cmd -f "$PHASE5_MIGRATION"
psql_cmd -f "$HARDENING_MIGRATION"

psql_cmd <<SQL
INSERT INTO tenants (id) VALUES
  ('$TENANT_ONE'::uuid),
  ('$TENANT_TWO'::uuid);

INSERT INTO canonical_entities (
  id,
  tenant_id,
  identity_scope,
  entity_type,
  canonical_name,
  normalized_name,
  status,
  resolution_confidence,
  resolution_method
)
VALUES
  (
    '$GLOBAL_ORG'::uuid,
    NULL,
    'global_public',
    'organization',
    'RTX Corporation',
    'rtx corporation',
    'active',
    1.0,
    'uei_exact'
  ),
  (
    '$TENANT_ONE_ORG'::uuid,
    '$TENANT_ONE'::uuid,
    'tenant_private',
    'organization',
    'Tenant One RTX account',
    'tenant one rtx account',
    'active',
    1.0,
    'crm_client'
  ),
  (
    '$TENANT_TWO_ORG'::uuid,
    '$TENANT_TWO'::uuid,
    'tenant_private',
    'organization',
    'Tenant Two Private Company',
    'tenant two private company',
    'active',
    1.0,
    'crm_client'
  ),
  (
    '$GLOBAL_PERSON'::uuid,
    NULL,
    'global_public',
    'person',
    'Jane Public',
    'jane public',
    'active',
    1.0,
    'directory_exact'
  );

INSERT INTO entity_aliases (
  entity_id,
  tenant_id,
  identity_scope,
  alias,
  normalized_alias,
  source_type,
  source_id,
  confidence,
  status
)
VALUES
  (
    '$GLOBAL_ORG'::uuid,
    NULL,
    'global_public',
    'Raytheon Technologies',
    'raytheon technologies',
    'sec_filing',
    '0000101829',
    1.0,
    'active'
  ),
  (
    '$GLOBAL_ORG'::uuid,
    '$TENANT_ONE'::uuid,
    'tenant_private',
    'Our RTX account',
    'our rtx account',
    'crm_client',
    'client-one',
    1.0,
    'active'
  ),
  (
    '$TENANT_TWO_ORG'::uuid,
    '$TENANT_TWO'::uuid,
    'tenant_private',
    'Private Co',
    'private co',
    'crm_client',
    'client-two',
    1.0,
    'active'
  );

INSERT INTO entity_identifiers (
  entity_id,
  tenant_id,
  identity_scope,
  identifier_type,
  identifier_value,
  normalized_value,
  source_type,
  source_id,
  confidence,
  status
)
VALUES
  (
    '$GLOBAL_ORG'::uuid,
    NULL,
    'global_public',
    'uei',
    'ABCDEF123456',
    'ABCDEF123456',
    'sam_entity',
    'ABCDEF123456',
    1.0,
    'active'
  ),
  (
    '$GLOBAL_ORG'::uuid,
    '$TENANT_ONE'::uuid,
    'tenant_private',
    'crm_client_id',
    'client-42',
    'CLIENT42',
    'crm_client',
    'client-42',
    1.0,
    'active'
  ),
  (
    '$TENANT_TWO_ORG'::uuid,
    '$TENANT_TWO'::uuid,
    'tenant_private',
    'crm_client_id',
    'client-42',
    'CLIENT42',
    'crm_client',
    'client-42',
    1.0,
    'active'
  );

INSERT INTO entity_resolutions (
  id,
  tenant_id,
  idempotency_key,
  actor_user_id,
  raw_input,
  normalized_input,
  entity_type_hint,
  candidate_entity_ids,
  selected_entity_id,
  status,
  confidence,
  resolution_method,
  provenance
)
VALUES (
  '$RESOLUTION_ONE'::uuid,
  '$TENANT_ONE'::uuid,
  repeat('1', 64),
  '$ACTOR_ONE'::uuid,
  'RTX',
  'rtx',
  'organization',
  jsonb_build_array('$GLOBAL_ORG'),
  '$GLOBAL_ORG'::uuid,
  'resolved',
  1.0,
  'identifier_exact',
  '[{"sourceType":"sam_entity","identifierType":"uei","matchValue":"ABCDEF123456"}]'::jsonb
);
SQL

# Candidate arrays cannot contain another tenant's private entity.
if psql_cmd <<SQL
INSERT INTO entity_resolutions (
  tenant_id, idempotency_key, raw_input, normalized_input, entity_type_hint,
  candidate_entity_ids, selected_entity_id, status, confidence,
  resolution_method, provenance
)
VALUES (
  '$TENANT_ONE'::uuid, repeat('2', 64), 'Private Co', 'private co', 'organization',
  jsonb_build_array('$TENANT_TWO_ORG'), NULL, 'unresolved', 0,
  'unresolved', '[]'::jsonb
);
SQL
then
  echo "ERROR: cross-tenant candidate unexpectedly committed." >&2
  exit 1
fi

# A selected entity must be one of the recorded candidates.
if psql_cmd <<SQL
INSERT INTO entity_resolutions (
  tenant_id, idempotency_key, raw_input, normalized_input, entity_type_hint,
  candidate_entity_ids, selected_entity_id, status, confidence,
  resolution_method, provenance
)
VALUES (
  '$TENANT_ONE'::uuid, repeat('3', 64), 'RTX', 'rtx', 'organization',
  jsonb_build_array('$TENANT_ONE_ORG'), '$GLOBAL_ORG'::uuid, 'resolved', 1,
  'user_selected', '[]'::jsonb
);
SQL
then
  echo "ERROR: selected entity outside candidate list unexpectedly committed." >&2
  exit 1
fi

# Ambiguous means at least two visible candidate entities.
if psql_cmd <<SQL
INSERT INTO entity_resolutions (
  tenant_id, idempotency_key, raw_input, normalized_input, entity_type_hint,
  candidate_entity_ids, selected_entity_id, status, confidence,
  resolution_method, provenance
)
VALUES (
  '$TENANT_ONE'::uuid, repeat('4', 64), 'RTX', 'rtx', 'organization',
  jsonb_build_array('$GLOBAL_ORG'), NULL, 'ambiguous', 0.98,
  'multiple_exact_candidates', '[]'::jsonb
);
SQL
then
  echo "ERROR: one-candidate ambiguous resolution unexpectedly committed." >&2
  exit 1
fi

# A corrected resolution must be attributable and linked.
if psql_cmd <<SQL
INSERT INTO entity_resolutions (
  tenant_id, idempotency_key, raw_input, normalized_input, entity_type_hint,
  candidate_entity_ids, selected_entity_id, status, confidence,
  resolution_method, provenance
)
VALUES (
  '$TENANT_ONE'::uuid, repeat('5', 64), 'RTX', 'rtx', 'organization',
  jsonb_build_array('$GLOBAL_ORG'), '$GLOBAL_ORG'::uuid, 'corrected', 1,
  'user_corrected', '[]'::jsonb
);
SQL
then
  echo "ERROR: unlinked correction unexpectedly committed." >&2
  exit 1
fi

# Correction lineage cannot rewrite the original query.
if psql_cmd <<SQL
INSERT INTO entity_resolutions (
  tenant_id, idempotency_key, actor_user_id, raw_input, normalized_input,
  entity_type_hint, candidate_entity_ids, selected_entity_id, status,
  confidence, resolution_method, provenance, correction_of_resolution_id
)
VALUES (
  '$TENANT_ONE'::uuid, repeat('6', 64), '$ACTOR_ONE'::uuid,
  'Different query', 'different query', 'organization',
  jsonb_build_array('$GLOBAL_ORG'), '$GLOBAL_ORG'::uuid, 'corrected',
  1, 'user_corrected', '[]'::jsonb, '$RESOLUTION_ONE'::uuid
);
SQL
then
  echo "ERROR: correction query drift unexpectedly committed." >&2
  exit 1
fi

# A valid correction appends a new row and preserves the original.
psql_cmd <<SQL
INSERT INTO entity_resolutions (
  id, tenant_id, idempotency_key, actor_user_id, raw_input, normalized_input,
  entity_type_hint, candidate_entity_ids, selected_entity_id, status,
  confidence, resolution_method, provenance, correction_of_resolution_id
)
VALUES (
  '$RESOLUTION_CORRECTION'::uuid, '$TENANT_ONE'::uuid, repeat('7', 64),
  '$ACTOR_ONE'::uuid, 'RTX', 'rtx', 'organization',
  jsonb_build_array('$GLOBAL_ORG', '$TENANT_ONE_ORG'), '$GLOBAL_ORG'::uuid,
  'corrected', 1, 'user_corrected',
  '[{"sourceType":"user_correction","sourceId":"99999999-9999-4999-8999-999999999999"}]'::jsonb,
  '$RESOLUTION_ONE'::uuid
);
SQL

# Resolution history is append-only.
if psql_cmd <<SQL
UPDATE entity_resolutions
SET confidence = 0.5
WHERE id = '$RESOLUTION_ONE'::uuid;
SQL
then
  echo "ERROR: immutable entity resolution unexpectedly updated." >&2
  exit 1
fi

if psql_cmd <<SQL
DELETE FROM entity_resolutions
WHERE id = '$RESOLUTION_ONE'::uuid;
SQL
then
  echo "ERROR: immutable entity resolution unexpectedly deleted." >&2
  exit 1
fi

# Tenant-private identity links cannot point to another tenant's private entity.
if psql_cmd <<SQL
INSERT INTO entity_aliases (
  entity_id, tenant_id, identity_scope, alias, normalized_alias,
  source_type, source_id, confidence, status
)
VALUES (
  '$TENANT_TWO_ORG'::uuid, '$TENANT_ONE'::uuid, 'tenant_private',
  'Leaked alias', 'leaked alias', 'crm_client', 'bad-link', 1, 'active'
);
SQL
then
  echo "ERROR: cross-tenant alias unexpectedly committed." >&2
  exit 1
fi

# Alias and identifier identity/provenance cannot be retargeted in place.
if psql_cmd <<SQL
UPDATE entity_aliases
SET source_id = 'rewritten'
WHERE tenant_id = '$TENANT_ONE'::uuid
  AND normalized_alias = 'our rtx account';
SQL
then
  echo "ERROR: alias provenance unexpectedly mutated." >&2
  exit 1
fi

if psql_cmd <<SQL
UPDATE entity_identifiers
SET normalized_value = 'DIFFERENT'
WHERE tenant_id = '$TENANT_ONE'::uuid
  AND identifier_type = 'crm_client_id';
SQL
then
  echo "ERROR: identifier identity unexpectedly mutated." >&2
  exit 1
fi

# Deterministic identifiers are unique within their visibility scope.
if psql_cmd <<SQL
INSERT INTO entity_identifiers (
  entity_id, tenant_id, identity_scope, identifier_type, identifier_value,
  normalized_value, source_type, source_id, confidence, status
)
VALUES (
  '$GLOBAL_PERSON'::uuid, NULL, 'global_public', 'uei', 'ABCDEF123456',
  'ABCDEF123456', 'sam_entity', 'duplicate', 1, 'active'
);
SQL
then
  echo "ERROR: duplicate global identifier unexpectedly committed." >&2
  exit 1
fi

if psql_cmd <<SQL
INSERT INTO entity_identifiers (
  entity_id, tenant_id, identity_scope, identifier_type, identifier_value,
  normalized_value, source_type, source_id, confidence, status
)
VALUES (
  '$TENANT_ONE_ORG'::uuid, '$TENANT_ONE'::uuid, 'tenant_private',
  'crm_client_id', 'client-42', 'CLIENT42', 'crm_client', 'duplicate', 1, 'active'
);
SQL
then
  echo "ERROR: duplicate tenant identifier unexpectedly committed." >&2
  exit 1
fi

# Scope and type cannot be rewritten in place.
if psql_cmd <<SQL
UPDATE canonical_entities
SET identity_scope = 'global_public', tenant_id = NULL
WHERE id = '$TENANT_ONE_ORG'::uuid;
SQL
then
  echo "ERROR: canonical entity scope unexpectedly mutated." >&2
  exit 1
fi

# Merges are type-safe and tenant-safe.
if psql_cmd <<SQL
UPDATE canonical_entities
SET status = 'merged', merged_into_entity_id = '$GLOBAL_PERSON'::uuid
WHERE id = '$TENANT_ONE_ORG'::uuid;
SQL
then
  echo "ERROR: cross-type merge unexpectedly committed." >&2
  exit 1
fi

if psql_cmd <<SQL
UPDATE canonical_entities
SET status = 'merged', merged_into_entity_id = '$TENANT_TWO_ORG'::uuid
WHERE id = '$TENANT_ONE_ORG'::uuid;
SQL
then
  echo "ERROR: cross-tenant merge unexpectedly committed." >&2
  exit 1
fi

# A private source may safely converge on a verified global identity.
psql_cmd <<SQL
UPDATE canonical_entities
SET status = 'merged', merged_into_entity_id = '$GLOBAL_ORG'::uuid
WHERE id = '$TENANT_ONE_ORG'::uuid;
SQL

# Ordinary tenant sessions may not create globally reusable identity.
if psql_cmd <<SQL
SET ROLE capiro_app;
SELECT set_config('app.current_tenant', '$TENANT_ONE', false);
INSERT INTO canonical_entities (
  tenant_id, identity_scope, entity_type, canonical_name, normalized_name,
  resolution_confidence, resolution_method
)
VALUES (
  NULL, 'global_public', 'organization', 'Unauthorized Global',
  'unauthorized global', 1, 'manual'
);
RESET ROLE;
SQL
then
  echo "ERROR: tenant session unexpectedly created a global entity." >&2
  exit 1
fi

# RLS exposes public identity plus the current tenant's private identity only.
psql_cmd <<SQL
SET ROLE capiro_app;
SELECT set_config('app.current_tenant', '$TENANT_ONE', false);
DO \$\$
DECLARE
  visible_entities INTEGER;
  visible_aliases INTEGER;
  visible_identifiers INTEGER;
  visible_resolutions INTEGER;
BEGIN
  SELECT COUNT(*) INTO visible_entities FROM canonical_entities;
  SELECT COUNT(*) INTO visible_aliases FROM entity_aliases;
  SELECT COUNT(*) INTO visible_identifiers FROM entity_identifiers;
  SELECT COUNT(*) INTO visible_resolutions FROM entity_resolutions;

  IF visible_entities <> 3 THEN
    RAISE EXCEPTION 'tenant entity visibility failed: %', visible_entities;
  END IF;
  IF visible_aliases <> 2 THEN
    RAISE EXCEPTION 'tenant alias visibility failed: %', visible_aliases;
  END IF;
  IF visible_identifiers <> 2 THEN
    RAISE EXCEPTION 'tenant identifier visibility failed: %', visible_identifiers;
  END IF;
  IF visible_resolutions <> 2 THEN
    RAISE EXCEPTION 'tenant resolution visibility failed: %', visible_resolutions;
  END IF;
END
\$\$;
RESET ROLE;
SQL

echo "Knowledge Plane Phase 5 Universal Entity Resolution PostgreSQL rehearsal passed."
