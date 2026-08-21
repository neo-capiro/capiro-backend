-- Phase 27A — Institutional Learning & Quality, signal-capture foundation.
-- One canonical, tenant-owned table for evidence that Capiro may have
-- learned something worth considering for future reuse. This is NOT a
-- second memory store: no message/document bodies are duplicated here, only
-- references to authoritative source objects plus governance metadata
-- reusing the existing MemoryClass/MemoryAuthority/MemorySensitivity/
-- SteeringLayer vocabularies. Capturing a row here never writes to
-- memory_items/memory_candidate/clio_memory and never changes Context Plane
-- recall — promotion into governed memory is a later, separate phase.

CREATE TABLE IF NOT EXISTS learning_signal (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL,
  client_id uuid NULL REFERENCES clients(id) ON DELETE CASCADE,

  source_surface varchar(32) NOT NULL
    CHECK (source_surface IN ('meri.chat', 'crm.fill_with_meri')),
  source_object_type varchar(64) NOT NULL,
  source_object_id uuid NOT NULL,
  source_run_id uuid NULL,

  signal_type varchar(48) NOT NULL
    CHECK (signal_type IN (
      'meri_feedback_positive', 'meri_feedback_negative',
      'crm_finding_accepted', 'crm_finding_rejected'
    )),

  proposed_memory_layer varchar(24) NULL
    CHECK (proposed_memory_layer IS NULL OR proposed_memory_layer IN (
      'firm-identity', 'firm-playbook', 'user-voice', 'client-steering', 'client-people'
    )),
  proposed_memory_class varchar(32) NULL
    CHECK (proposed_memory_class IS NULL OR proposed_memory_class IN (
      'institutional_authoritative', 'client_steering', 'user_preference',
      'episodic_working', 'legacy_unclassified'
    )),

  evidence_jsonb jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence real NULL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),

  source_authority varchar(24) NULL
    CHECK (source_authority IS NULL OR source_authority IN (
      'firm_approved', 'client_approved', 'external_authoritative', 'user_asserted',
      'analyst_verified', 'working_draft', 'model_inferred', 'legacy_unclassified'
    )),
  sensitivity varchar(16) NOT NULL DEFAULT 'normal'
    CHECK (sensitivity IN ('normal', 'confidential', 'restricted')),
  provenance_kind varchar(24) NOT NULL
    CHECK (provenance_kind IN ('human_explicit', 'human_implicit', 'ai_generated_only', 'system_derived')),
  provenance_jsonb jsonb NOT NULL DEFAULT '{}'::jsonb,

  governance_requirement varchar(16) NOT NULL DEFAULT 'human_required'
    CHECK (governance_requirement IN ('human_required', 'auto_eligible', 'unknown')),
  status varchar(16) NOT NULL DEFAULT 'captured'
    CHECK (status IN ('captured', 'discarded')),

  idempotency_key varchar(320) NOT NULL,

  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  -- The core anti-feedback-loop invariant, enforced at the database level as
  -- well as in application code (contract.ts's assertNoAiSelfCorroboration):
  -- an AI-only provenance can never carry a human-tier authority.
  CONSTRAINT learning_signal_no_ai_self_corroboration_chk CHECK (
    provenance_kind IN ('human_explicit', 'human_implicit')
    OR source_authority IS NULL
    OR source_authority NOT IN (
      'firm_approved', 'client_approved', 'external_authoritative', 'user_asserted', 'analyst_verified'
    )
  ),
  CONSTRAINT learning_signal_tenant_idempotency_unique UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS learning_signal_tenant_client_idx
  ON learning_signal (tenant_id, client_id);
CREATE INDEX IF NOT EXISTS learning_signal_tenant_actor_idx
  ON learning_signal (tenant_id, actor_user_id);
CREATE INDEX IF NOT EXISTS learning_signal_tenant_surface_type_idx
  ON learning_signal (tenant_id, source_surface, signal_type);
CREATE INDEX IF NOT EXISTS learning_signal_tenant_status_created_idx
  ON learning_signal (tenant_id, status, created_at DESC);

-- Belt-and-suspenders only: the runtime capiro_app role is a member of the
-- table owner and bypasses RLS (see PrismaService's class doc comment).
-- Real tenant isolation is the Prisma tenant-scope query extension, enforced
-- by apps/api/src/prisma/tenant-scope-guard.spec.ts. RLS here uses the
-- canonical current_tenant_id()/rls_bypass() helpers from
-- 20260501000000_init_identity_tenancy, matching the convention those
-- helpers were introduced for (NOT the app.tenant_id GUC name used by the
-- older client_profile_fill_* migration, which the app never actually sets).
ALTER TABLE learning_signal ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning_signal FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS learning_signal_tenant_isolation ON learning_signal;
CREATE POLICY learning_signal_tenant_isolation ON learning_signal
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE ON learning_signal TO capiro_app;
  END IF;
END $$;
