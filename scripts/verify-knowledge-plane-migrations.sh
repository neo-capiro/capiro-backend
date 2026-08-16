#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PHASE12_MIGRATION="$ROOT_DIR/apps/api/prisma/migrations/20261120050000_knowledge_events_assertions/migration.sql"
PHASE3_MIGRATION="$ROOT_DIR/apps/api/prisma/migrations/20261120060000_knowledge_evidence/migration.sql"
DROP_CREATED_BY_FKEY_MIGRATION="$ROOT_DIR/apps/api/prisma/migrations/20261120080000_drop_knowledge_assertions_created_by_fkey/migration.sql"

TENANT_ONE="11111111-1111-4111-8111-111111111111"
TENANT_TWO="22222222-2222-4222-8222-222222222222"
USER_ONE="33333333-3333-4333-8333-333333333333"
EVENT_ONE="44444444-4444-4444-8444-444444444444"
EVENT_TWO="55555555-5555-4555-8555-555555555555"
ASSERTION_ONE="66666666-6666-4666-8666-666666666666"
ASSERTION_WITHOUT_EVIDENCE="77777777-7777-4777-8777-777777777777"
EVIDENCE_ONE="88888888-8888-4888-8888-888888888888"
SOURCE_HASH="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

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
CREATE TABLE users (
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

psql_cmd -f "$PHASE12_MIGRATION"
psql_cmd -f "$PHASE3_MIGRATION"
psql_cmd -f "$DROP_CREATED_BY_FKEY_MIGRATION"

# created_by remains; the FK must be gone so user deletion cannot mutate assertions.
psql_cmd <<SQL
DO \$\$
DECLARE
  has_column BOOLEAN;
  has_fkey BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'knowledge_assertions'
      AND column_name = 'created_by'
  ) INTO has_column;
  IF NOT has_column THEN
    RAISE EXCEPTION 'created_by column missing after drop-fkey migration';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'knowledge_assertions_created_by_fkey'
  ) INTO has_fkey;
  IF has_fkey THEN
    RAISE EXCEPTION 'knowledge_assertions_created_by_fkey still present';
  END IF;
END
\$\$;
SQL

psql_cmd <<SQL
INSERT INTO tenants (id) VALUES
  ('$TENANT_ONE'::uuid),
  ('$TENANT_TWO'::uuid);
INSERT INTO users (id) VALUES ('$USER_ONE'::uuid);

INSERT INTO knowledge_events (
  id,
  tenant_id,
  idempotency_key,
  source_type,
  source_id,
  source_version,
  source_content_hash,
  event_type,
  occurred_at,
  observed_at,
  evidence_locator,
  sensitivity,
  access_scope
)
VALUES
  (
    '$EVENT_ONE'::uuid,
    '$TENANT_ONE'::uuid,
    repeat('1', 64),
    'gmail_message',
    'message-one',
    'v1',
    '$SOURCE_HASH',
    'email_received',
    '2026-03-14T14:00:00Z',
    '2026-03-14T14:01:00Z',
    '{"provider":"google","messageId":"message-one"}'::jsonb,
    'normal',
    '{"kind":"tenant"}'::jsonb
  ),
  (
    '$EVENT_TWO'::uuid,
    '$TENANT_TWO'::uuid,
    repeat('2', 64),
    'gmail_message',
    'message-two',
    'v1',
    '$SOURCE_HASH',
   'email_received',
    '2026-03-14T14:00:00Z',
    '2026-03-14T14:01:00Z',
    '{"provider":"google","messageId":"message-two"}'::jsonb,
    'normal',
    '{"kind":"tenant"}'::jsonb
  );

BEGIN;
INSERT INTO knowledge_assertions (
  id,
  tenant_id,
  idempotency_key,
  origin_event_id,
  subject_type,
  subject_id,
  predicate,
  object_type,
  object_value,
  assertion_class,
  confidence,
  authority,
  observed_at,
  valid_from,
  sensitivity,
  access_scope,
  created_by
)
VALUES (
  '$ASSERTION_ONE'::uuid,
  '$TENANT_ONE'::uuid,
  repeat('3', 64),
  '$EVENT_ONE'::uuid,
  'client',
  'overland-ai',
  'prefers',
  'strategy',
  '"direct appropriations strategy"'::jsonb,
  'preference',
  0.95,
  'source_reported',
  '2026-03-14T14:01:00Z',
  '2026-03-14T14:01:00Z',
  'normal',
  '{"kind":"tenant"}'::jsonb,
  '$USER_ONE'::uuid
);
INSERT INTO knowledge_evidence (
  id,
  tenant_id,
  assertion_id,
  event_id,
  source_type,
  source_id,
  excerpt,
  start_offset,
  end_offset,
  content_hash
)
VALUES (
  '$EVIDENCE_ONE'::uuid,
  '$TENANT_ONE'::uuid,
  '$ASSERTION_ONE'::uuid,
  '$EVENT_ONE'::uuid,
  'gmail_message',
  'message-one',
  'direct appropriations strategy',
  0,
  30,
  '$SOURCE_HASH'
);
COMMIT;
SQL

# The deferred constraint must reject an evidence-less durable assertion at commit.
if psql_cmd <<SQL
BEGIN;
INSERT INTO knowledge_assertions (
  id,
  tenant_id,
  idempotency_key,
  origin_event_id,
  subject_type,
  subject_id,
  predicate,
  object_type,
  object_value,
  assertion_class,
  confidence,
  authority,
  observed_at,
  valid_from,
  sensitivity,
  access_scope
)
VALUES (
  '$ASSERTION_WITHOUT_EVIDENCE'::uuid,
  '$TENANT_ONE'::uuid,
  repeat('4', 64),
  '$EVENT_ONE'::uuid,
  'client',
  'overland-ai',
  'opposes',
  'provision',
  '"section-421"'::jsonb,
  'position',
  0.90,
  'source_reported',
  '2026-03-14T14:01:00Z',
  '2026-03-14T14:01:00Z',
  'normal',
  '{"kind":"tenant"}'::jsonb
);
COMMIT;
SQL
then
  echo "ERROR: evidence-less assertion unexpectedly committed." >&2
  exit 1
fi

# A tenant-one assertion may not attach a tenant-two event.
if psql_cmd <<SQL
INSERT INTO knowledge_evidence (
  tenant_id,
  assertion_id,
  event_id,
  source_type,
  source_id,
  excerpt,
  start_offset,
  end_offset,
  content_hash
)
VALUES (
  '$TENANT_ONE'::uuid,
  '$ASSERTION_ONE'::uuid,
  '$EVENT_TWO'::uuid,
  'gmail_message',
  'message-two',
  'cross tenant',
  0,
  12,
  '$SOURCE_HASH'
);
SQL
then
  echo "ERROR: cross-tenant evidence unexpectedly committed." >&2
  exit 1
fi

# Evidence is append-only even for the table owner unless the explicit purge
# contract is enabled alongside rls bypass.
if psql_cmd <<SQL
UPDATE knowledge_evidence
SET excerpt = 'mutated'
WHERE id = '$EVIDENCE_ONE'::uuid;
SQL
then
  echo "ERROR: immutable evidence unexpectedly updated." >&2
  exit 1
fi

# The application role sees only the configured tenant despite holding SELECT.
psql_cmd <<SQL
SET ROLE capiro_app;
SELECT set_config('app.current_tenant', '$TENANT_ONE', false);
DO \$\$
DECLARE
  visible_events INTEGER;
  visible_evidence INTEGER;
BEGIN
  SELECT COUNT(*) INTO visible_events FROM knowledge_events;
  SELECT COUNT(*) INTO visible_evidence FROM knowledge_evidence;
  IF visible_events <> 1 OR visible_evidence <> 1 THEN
    RAISE EXCEPTION 'tenant RLS rehearsal failed: events %, evidence %',
      visible_events,
      visible_evidence;
  END IF;
END
\$\$;
RESET ROLE;
SQL

echo "Knowledge Plane Phase 1-3 PostgreSQL rehearsal passed."
