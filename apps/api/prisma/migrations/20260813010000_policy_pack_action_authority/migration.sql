-- Phase 10: persisted policy packs become the single server-owned action-policy authority.
-- Additive only; no seed, no production flag change, and no shared-environment execution.

ALTER TABLE meri_action_proposals
  ADD COLUMN IF NOT EXISTS policy_pack_id uuid REFERENCES compliance_policy_pack(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS policy_pack_key varchar(120),
  ADD COLUMN IF NOT EXISTS policy_pack_version varchar(80),
  ADD COLUMN IF NOT EXISTS policy_binding varchar(280),
  ADD COLUMN IF NOT EXISTS policy_decision_hash varchar(64),
  ADD COLUMN IF NOT EXISTS policy_context_hash varchar(64),
  ADD COLUMN IF NOT EXISTS policy_source varchar(24),
  ADD COLUMN IF NOT EXISTS policy_mode varchar(16),
  ADD COLUMN IF NOT EXISTS policy_jurisdiction varchar(32),
  ADD COLUMN IF NOT EXISTS policy_channel varchar(24),
  ADD COLUMN IF NOT EXISTS policy_recipient_type varchar(24),
  ADD COLUMN IF NOT EXISTS policy_client_id uuid,
  ADD COLUMN IF NOT EXISTS policy_effective_user_id uuid,
  ADD COLUMN IF NOT EXISTS policy_effective_at timestamptz;

UPDATE meri_action_proposals
SET policy_pack_key = COALESCE(policy_pack_key, 'legacy-static'),
    policy_pack_version = COALESCE(policy_pack_version, policy_version, 'legacy'),
    policy_binding = COALESCE(policy_binding, 'legacy-static@legacy:fallback'),
    policy_decision_hash = COALESCE(policy_decision_hash, repeat('0', 64)),
    policy_context_hash = COALESCE(policy_context_hash, repeat('0', 64)),
    policy_source = COALESCE(policy_source, 'legacy_static'),
    policy_mode = COALESCE(policy_mode, 'off'),
    policy_jurisdiction = COALESCE(policy_jurisdiction, 'federal'),
    policy_channel = COALESCE(policy_channel, 'internal'),
    policy_effective_user_id = COALESCE(policy_effective_user_id, user_id),
    policy_effective_at = COALESCE(policy_effective_at, created_at);

ALTER TABLE meri_action_proposals
  ALTER COLUMN policy_pack_key SET NOT NULL,
  ALTER COLUMN policy_pack_version SET NOT NULL,
  ALTER COLUMN policy_binding SET NOT NULL,
  ALTER COLUMN policy_decision_hash SET NOT NULL,
  ALTER COLUMN policy_context_hash SET NOT NULL,
  ALTER COLUMN policy_source SET NOT NULL,
  ALTER COLUMN policy_mode SET NOT NULL,
  ALTER COLUMN policy_jurisdiction SET NOT NULL,
  ALTER COLUMN policy_channel SET NOT NULL,
  ALTER COLUMN policy_effective_user_id SET NOT NULL,
  ALTER COLUMN policy_effective_at SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE meri_action_proposals ADD CONSTRAINT meri_action_proposals_policy_source_check
    CHECK (policy_source IN ('static','persisted','fail_closed','legacy_static'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE meri_action_proposals ADD CONSTRAINT meri_action_proposals_policy_mode_check
    CHECK (policy_mode IN ('off','shadow','enforce'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS meri_action_proposals_policy_pack_idx
  ON meri_action_proposals (tenant_id, policy_pack_key, policy_pack_version);
CREATE INDEX IF NOT EXISTS meri_action_proposals_policy_decision_idx
  ON meri_action_proposals (tenant_id, policy_decision_hash);

ALTER TABLE compliance_check
  ADD COLUMN IF NOT EXISTS policy_pack_key varchar(120),
  ADD COLUMN IF NOT EXISTS policy_pack_version varchar(80),
  ADD COLUMN IF NOT EXISTS policy_binding varchar(280),
  ADD COLUMN IF NOT EXISTS policy_decision_hash varchar(64);

ALTER TABLE compliance_policy_decision
  ADD COLUMN IF NOT EXISTS decision_hash varchar(64),
  ADD COLUMN IF NOT EXISTS context_hash varchar(64),
  ADD COLUMN IF NOT EXISTS policy_source varchar(24),
  ADD COLUMN IF NOT EXISTS policy_mode varchar(16),
  ADD COLUMN IF NOT EXISTS effective_user_id uuid,
  ADD COLUMN IF NOT EXISTS effective_at timestamptz;

UPDATE compliance_policy_decision
SET decision_hash = COALESCE(decision_hash, repeat('0', 64)),
    context_hash = COALESCE(context_hash, repeat('0', 64)),
    policy_source = COALESCE(policy_source, CASE WHEN policy_pack_id IS NULL THEN 'static' ELSE 'persisted' END),
    policy_mode = COALESCE(policy_mode, 'off'),
    effective_user_id = COALESCE(effective_user_id, actor_user_id),
    effective_at = COALESCE(effective_at, decided_at);

ALTER TABLE compliance_policy_decision
  ALTER COLUMN decision_hash SET NOT NULL,
  ALTER COLUMN context_hash SET NOT NULL,
  ALTER COLUMN policy_source SET NOT NULL,
  ALTER COLUMN policy_mode SET NOT NULL,
  ALTER COLUMN effective_user_id SET NOT NULL,
  ALTER COLUMN effective_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS compliance_policy_decision_hash_idx
  ON compliance_policy_decision (tenant_id, decision_hash);

ALTER TABLE compliance_policy_pack_event
  DROP CONSTRAINT IF EXISTS compliance_policy_pack_event_action_check;
ALTER TABLE compliance_policy_pack_event
  ADD CONSTRAINT compliance_policy_pack_event_action_check CHECK (
    action IN ('create','revise','submit_review','review','approve','publish','retire','rollback','simulate')
  );
