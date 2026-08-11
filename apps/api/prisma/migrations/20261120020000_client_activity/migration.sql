-- Normalized CRM activity (Client CRM vNext, Figma 906:3360).
--
-- The vNext relationship history needs email/call/note/outreach/document/
-- request/decision/commitment, where the old profile combined only action,
-- meeting and file — and did so in frontend memory, so nothing survived a
-- reload. Contract §9: "Create or reuse a normalized durable CRM activity
-- contract rather than fabricating these in frontend state."
--
-- Two kinds of row end up on one timeline:
--   * DERIVED   — meetings, attachments, outreach and actions already exist as
--                 first-class records. They are NOT copied here; the read model
--                 unions them at query time so there is one source of truth.
--   * RECORDED  — what a user logs by hand (a call, a note, a commitment, a
--                 decision) has no other home, and lives in this table.
--
-- source_type/source_id are kept on recorded rows too, so a note logged against
-- a meeting can still open that meeting.

CREATE TABLE IF NOT EXISTS client_activity (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  kind varchar(24) NOT NULL
    CHECK (kind IN (
      'email', 'call', 'note', 'meeting', 'outreach',
      'document', 'request', 'decision', 'commitment'
    )),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  title text NOT NULL,
  body text NULL,
  -- Who did it, and which client contact it involved.
  actor_user_id uuid NULL,
  person_id uuid NULL REFERENCES client_people(id) ON DELETE SET NULL,
  -- Identity of the underlying record, so a row can open what it describes.
  source_type varchar(32) NULL,
  source_id varchar(128) NULL,
  -- Pinned notes and commitments must survive reload (§9).
  pinned boolean NOT NULL DEFAULT false,
  -- Commitments carry a due date and a settled flag; other kinds leave both null.
  due_at timestamptz NULL,
  settled_at timestamptz NULL,
  metadata_jsonb jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_activity_due_only_for_commitment_chk
    CHECK (due_at IS NULL OR kind IN ('commitment', 'request')),
  CONSTRAINT client_activity_settled_needs_due_chk
    CHECK (settled_at IS NULL OR due_at IS NOT NULL)
);

-- Timeline read: newest first, per client.
CREATE INDEX IF NOT EXISTS client_activity_timeline_idx
  ON client_activity (tenant_id, client_id, occurred_at DESC);
-- Filter chips read by kind.
CREATE INDEX IF NOT EXISTS client_activity_kind_idx
  ON client_activity (tenant_id, client_id, kind, occurred_at DESC);
-- Pinned rail is a small hot set.
CREATE INDEX IF NOT EXISTS client_activity_pinned_idx
  ON client_activity (tenant_id, client_id, occurred_at DESC)
  WHERE pinned;
-- Open commitments.
CREATE INDEX IF NOT EXISTS client_activity_open_commitment_idx
  ON client_activity (tenant_id, client_id, due_at)
  WHERE due_at IS NOT NULL AND settled_at IS NULL;

ALTER TABLE client_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_activity FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS client_activity_tenant_isolation ON client_activity;
CREATE POLICY client_activity_tenant_isolation ON client_activity
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
