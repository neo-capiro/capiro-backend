#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PHASE4_MIGRATION="$ROOT_DIR/apps/api/prisma/migrations/20261120070000_mailbox_knowledge_ingestion/migration.sql"
DROP_CREATED_BY_FKEY_MIGRATION="$ROOT_DIR/apps/api/prisma/migrations/20261120080000_drop_knowledge_assertions_created_by_fkey/migration.sql"
INCREMENTAL_ONLY_MIGRATION="$ROOT_DIR/apps/api/prisma/migrations/20261120090000_mailbox_knowledge_incremental_only/migration.sql"

TENANT_ONE="11111111-1111-4111-8111-111111111111"
CONNECTION_ONE="99999999-9999-4999-8999-999999999991"
THREAD_ONE="99999999-9999-4999-8999-999999999992"
MESSAGE_ONE="99999999-9999-4999-8999-999999999993"
MESSAGE_MANUAL="99999999-9999-4999-8999-999999999994"
MESSAGE_REMOVED="99999999-9999-4999-8999-999999999995"
MESSAGE_BACKFILL="99999999-9999-4999-8999-999999999996"
MESSAGE_TRUNCATED="99999999-9999-4999-8999-999999999997"
EVENT_TWO="55555555-5555-4555-8555-555555555555"

psql_cmd() {
  psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 "$@"
}

# The Phase 1-3 rehearsal runs immediately before this script and deliberately
# leaves its isolated schema in place. Add only the engagement tables Phase 4's
# migration references.
psql_cmd <<SQL
CREATE TYPE engagement_source AS ENUM ('outlook', 'google', 'imap_caldav', 'manual');

CREATE TABLE engagement_connections (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_email TEXT,
  created_by_user_id UUID
);

CREATE TABLE mail_threads (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id UUID,
  connection_id UUID REFERENCES engagement_connections(id) ON DELETE SET NULL,
  source engagement_source NOT NULL,
  external_id TEXT,
  subject TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE mail_messages (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  thread_id UUID NOT NULL REFERENCES mail_threads(id) ON DELETE CASCADE,
  connection_id UUID REFERENCES engagement_connections(id) ON DELETE SET NULL,
  source engagement_source NOT NULL,
  external_id TEXT,
  subject TEXT,
  from_email TEXT,
  from_name TEXT,
  to_recipients_jsonb JSONB NOT NULL DEFAULT '[]'::jsonb,
  cc_recipients_jsonb JSONB NOT NULL DEFAULT '[]'::jsonb,
  bcc_recipients_jsonb JSONB NOT NULL DEFAULT '[]'::jsonb,
  sent_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  body_text TEXT,
  body_html_s3_key TEXT,
  has_attachments BOOLEAN NOT NULL DEFAULT FALSE,
  removed_at TIMESTAMPTZ,
  removed_reason VARCHAR(32),
  metadata_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_jsonb JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE engagement_attachments (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  mail_message_id UUID REFERENCES mail_messages(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INTEGER,
  lifecycle_status VARCHAR(32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
SQL

psql_cmd -f "$PHASE4_MIGRATION"
psql_cmd -f "$DROP_CREATED_BY_FKEY_MIGRATION"
psql_cmd -f "$INCREMENTAL_ONLY_MIGRATION"

# Prove created_by remains and the FK is gone.
psql_cmd <<SQL
DO \$\$
DECLARE
  has_column BOOLEAN;
  has_fkey BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'knowledge_assertions' AND column_name = 'created_by'
  ) INTO has_column;
  IF NOT has_column THEN
    RAISE EXCEPTION 'created_by column was removed; it must remain as an immutable audit UUID';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'knowledge_assertions_created_by_fkey'
  ) INTO has_fkey;
  IF has_fkey THEN
    RAISE EXCEPTION 'knowledge_assertions_created_by_fkey still exists after drop migration';
  END IF;
END
\$\$;
SQL

psql_cmd <<SQL
INSERT INTO engagement_connections (
  id,
  tenant_id,
  account_email,
  created_by_user_id
)
VALUES (
  '$CONNECTION_ONE'::uuid,
  '$TENANT_ONE'::uuid,
  'neo@capiro.ai',
  '33333333-3333-4333-8333-333333333333'::uuid
);

INSERT INTO mail_threads (
  id,
  tenant_id,
  connection_id,
  source,
  external_id,
  subject
)
VALUES (
  '$THREAD_ONE'::uuid,
  '$TENANT_ONE'::uuid,
  '$CONNECTION_ONE'::uuid,
  'google',
  'thread-one',
  'FY28 priorities'
);

INSERT INTO mail_messages (
  id,
  tenant_id,
  thread_id,
  connection_id,
  source,
  external_id,
  subject,
  from_email,
  to_recipients_jsonb,
  received_at,
  body_text,
  metadata_jsonb,
  raw_jsonb
)
VALUES (
  '$MESSAGE_ONE'::uuid,
  '$TENANT_ONE'::uuid,
  '$THREAD_ONE'::uuid,
  '$CONNECTION_ONE'::uuid,
  'google',
  'gmail-message-one',
  'FY28 priorities',
  'jane@example.com',
  '[{"email":"neo@capiro.ai","name":"Neo"}]'::jsonb,
  '2026-08-14T13:00:00Z',
  'Please protect PE 0605053A and avoid leading with autonomy.',
  '{"folder":"inbox","bodyCompleteness":"full","mailboxSyncMode":"incremental"}'::jsonb,
  '{"snippet":"Please protect PE 0605053A..."}'::jsonb
);

DO \$\$
DECLARE
  queued INTEGER;
BEGIN
  SELECT COUNT(*) INTO queued
  FROM knowledge_mailbox_jobs
  WHERE tenant_id = '$TENANT_ONE'::uuid
    AND mail_message_id = '$MESSAGE_ONE'::uuid
    AND status = 'pending';
  IF queued <> 1 THEN
    RAISE EXCEPTION 'expected one incremental mailbox job, found %', queued;
  END IF;
END
\$\$;

-- Explicit backfill mode must create ZERO knowledge jobs (no date heuristic).
INSERT INTO mail_messages (
  id,
  tenant_id,
  thread_id,
  connection_id,
  source,
  external_id,
  subject,
  from_email,
  to_recipients_jsonb,
  received_at,
  body_text,
  metadata_jsonb
)
VALUES (
  '$MESSAGE_BACKFILL'::uuid,
  '$TENANT_ONE'::uuid,
  '$THREAD_ONE'::uuid,
  '$CONNECTION_ONE'::uuid,
  'google',
  'gmail-backfill-one',
  'Historical backfill mail',
  'jane@example.com',
  '[{"email":"neo@capiro.ai","name":"Neo"}]'::jsonb,
  '2026-08-14T12:00:00Z',
  'Please protect PE 0605053A during historical mailbox load.',
  '{"folder":"inbox","bodyCompleteness":"full","mailboxSyncMode":"backfill"}'::jsonb
);

DO \$\$
DECLARE
  queued INTEGER;
BEGIN
  SELECT COUNT(*) INTO queued
  FROM knowledge_mailbox_jobs
  WHERE mail_message_id = '$MESSAGE_BACKFILL'::uuid;
  IF queued <> 0 THEN
    RAISE EXCEPTION 'backfill mailbox row unexpectedly queued % knowledge jobs', queued;
  END IF;
END
\$\$;

-- Truncated bodies (storage-cap) must never enqueue even when incremental.
INSERT INTO mail_messages (
  id,
  tenant_id,
  thread_id,
  connection_id,
  source,
  external_id,
  subject,
  from_email,
  received_at,
  body_text,
  metadata_jsonb
)
VALUES (
  '$MESSAGE_TRUNCATED'::uuid,
  '$TENANT_ONE'::uuid,
  '$THREAD_ONE'::uuid,
  '$CONNECTION_ONE'::uuid,
  'outlook',
  'graph-truncated-one',
  'Truncated body',
  'a@acme.com',
  '2026-08-14T14:00:00Z',
  'Truncated body content that is not complete evidence.',
  '{"folder":"inbox","bodyCompleteness":"truncated","mailboxSyncMode":"incremental"}'::jsonb
);

DO \$\$
DECLARE
  queued INTEGER;
BEGIN
  SELECT COUNT(*) INTO queued
  FROM knowledge_mailbox_jobs
  WHERE mail_message_id = '$MESSAGE_TRUNCATED'::uuid;
  IF queued <> 0 THEN
    RAISE EXCEPTION 'truncated body unexpectedly queued % knowledge jobs', queued;
  END IF;
END
\$\$;

-- Provider upserts that do not materially change a message must not manufacture
-- another revision merely because an UPDATE statement ran.
UPDATE mail_messages
SET body_text = body_text
WHERE id = '$MESSAGE_ONE'::uuid;

DO \$\$
DECLARE
  queued INTEGER;
BEGIN
  SELECT COUNT(*) INTO queued
  FROM knowledge_mailbox_jobs
  WHERE mail_message_id = '$MESSAGE_ONE'::uuid;
  IF queued <> 1 THEN
    RAISE EXCEPTION 'identical provider update created % jobs instead of one', queued;
  END IF;
END
\$\$;

-- A material source change creates a second resumable revision, and the shared
-- revision function identifies only the newest one as current.
UPDATE mail_messages
SET subject = 'Updated FY28 priorities'
WHERE id = '$MESSAGE_ONE'::uuid;

DO \$\$
DECLARE
  queued INTEGER;
  current_revision TEXT;
  matching_current INTEGER;
BEGIN
  SELECT COUNT(*) INTO queued
  FROM knowledge_mailbox_jobs
  WHERE mail_message_id = '$MESSAGE_ONE'::uuid;
  IF queued <> 2 THEN
    RAISE EXCEPTION 'material provider update did not create a second job: %', queued;
  END IF;

  SELECT mailbox_knowledge_source_revision(
    source::text,
    external_id,
    subject,
    from_email,
    to_recipients_jsonb,
    cc_recipients_jsonb,
    bcc_recipients_jsonb,
    sent_at,
    received_at,
    body_text,
    has_attachments
  ) INTO current_revision
  FROM mail_messages
  WHERE id = '$MESSAGE_ONE'::uuid;

  SELECT COUNT(*) INTO matching_current
  FROM knowledge_mailbox_jobs
  WHERE mail_message_id = '$MESSAGE_ONE'::uuid
    AND source_revision = current_revision;
  IF matching_current <> 1 THEN
    RAISE EXCEPTION 'current message revision did not resolve to exactly one job: %', matching_current;
  END IF;
END
\$\$;

-- Manual mail and provider-removed rows are intentionally outside the live
-- Phase 4 ingestion contract.
INSERT INTO mail_messages (
  id, tenant_id, thread_id, source, external_id, body_text
)
VALUES (
  '$MESSAGE_MANUAL'::uuid,
  '$TENANT_ONE'::uuid,
  '$THREAD_ONE'::uuid,
  'manual',
  'manual-one',
  'Manual note that must not be treated as provider evidence.'
);
INSERT INTO mail_messages (
  id, tenant_id, thread_id, source, external_id, body_text, removed_at
)
VALUES (
  '$MESSAGE_REMOVED'::uuid,
  '$TENANT_ONE'::uuid,
  '$THREAD_ONE'::uuid,
  'google',
  'removed-one',
  'Removed provider content.',
  CURRENT_TIMESTAMP
);

DO \$\$
DECLARE
  unexpected INTEGER;
BEGIN
  SELECT COUNT(*) INTO unexpected
  FROM knowledge_mailbox_jobs
  WHERE mail_message_id IN ('$MESSAGE_MANUAL'::uuid, '$MESSAGE_REMOVED'::uuid);
  IF unexpected <> 0 THEN
    RAISE EXCEPTION 'manual/removed messages unexpectedly queued: %', unexpected;
  END IF;
END
\$\$;
SQL

# Same-tenant database invariants are enforced even for direct SQL.
if psql_cmd <<SQL
INSERT INTO knowledge_mailbox_jobs (
  tenant_id, mail_message_id, source_revision
)
VALUES (
  '22222222-2222-4222-8222-222222222222'::uuid,
  '$MESSAGE_ONE'::uuid,
  repeat('a', 32)
);
SQL
then
  echo "ERROR: cross-tenant mailbox job unexpectedly committed." >&2
  exit 1
fi

if psql_cmd <<SQL
UPDATE knowledge_mailbox_jobs
SET
  status = 'succeeded',
  result_event_id = '$EVENT_TWO'::uuid,
  processed_content_hash = repeat('b', 64)
WHERE tenant_id = '$TENANT_ONE'::uuid
  AND mail_message_id = '$MESSAGE_ONE'::uuid
  AND status = 'pending';
SQL
then
  echo "ERROR: cross-tenant result event unexpectedly linked." >&2
  exit 1
fi

if psql_cmd <<SQL
UPDATE knowledge_mailbox_jobs
SET status = 'processing'
WHERE tenant_id = '$TENANT_ONE'::uuid
  AND mail_message_id = '$MESSAGE_ONE'::uuid
  AND status = 'pending';
SQL
then
  echo "ERROR: processing state without a lease unexpectedly committed." >&2
  exit 1
fi

# The application role sees the jobs only through the configured tenant scope.
psql_cmd <<SQL
SET ROLE capiro_app;
SELECT set_config('app.current_tenant', '$TENANT_ONE', false);
DO \$\$
DECLARE
  visible_jobs INTEGER;
BEGIN
  SELECT COUNT(*) INTO visible_jobs FROM knowledge_mailbox_jobs;
  IF visible_jobs <> 2 THEN
    RAISE EXCEPTION 'mailbox job RLS rehearsal failed: % visible', visible_jobs;
  END IF;
END
\$\$;
RESET ROLE;
SQL

echo "Knowledge Plane Phase 4 mailbox migration rehearsal passed."
