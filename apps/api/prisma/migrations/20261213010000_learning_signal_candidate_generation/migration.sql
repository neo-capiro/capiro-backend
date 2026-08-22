-- Phase 27B — governed candidate generation from LearningSignal rows.
--
-- Extends the EXISTING memory_candidate governance pipeline (Phase 3's
-- memory_governance_context_v2 + the review-workflow/transition-audit
-- machinery built on top of it) rather than introducing a parallel
-- candidate/approval store. Two additive changes to memory_candidate:
--
--   1. Widen the source_kind CHECK to allow 'learning_signal' — the ONE new
--      sourceKind value LearningSignalCandidateService uses for every
--      candidate it proposes, regardless of which 27A adapter (Meri
--      feedback, CRM Fill) the originating signal came from. Finer-grained
--      origin (surface/signalType) already lives on the referenced
--      learning_signal row, not duplicated into source_kind.
--   2. A partial unique index so candidate generation is idempotent at the
--      database level, not just by application convention: at most one
--      memory_candidate may ever exist per (tenant, learning_signal). This
--      reuses the source_type/source_id columns memory_governance_context_v2
--      already added (a NEW source_type value, 'learning_signal_capture',
--      not a new column) rather than inventing a bespoke
--      sourceLearningSignalId column.
--
-- Every learning_signal is either promoted to exactly one memory_candidate,
-- or recorded as ineligible with a reason in the new
-- learning_signal_candidate_outcome table below — never silently dropped
-- (Phase 27B handoff §19). That table is NOT a second candidate store: it
-- carries no proposed fact/value, only "was a candidate created for this
-- signal, and if not, why" — the same relationship
-- memory_transition_audit has to memory_candidate/memory_items, applied one
-- layer upstream.

ALTER TABLE "memory_candidate" DROP CONSTRAINT "memory_candidate_source_kind_chk";

ALTER TABLE "memory_candidate" ADD CONSTRAINT "memory_candidate_source_kind_chk"
  CHECK ("source_kind" IN (
    'explicit_user', 'workflow_event', 'artifact_approval', 'model_extraction',
    'settings_sections', 'learning_signal'
  ));

CREATE UNIQUE INDEX IF NOT EXISTS memory_candidate_learning_signal_source_unique
  ON memory_candidate (tenant_id, source_id)
  WHERE source_type = 'learning_signal_capture' AND source_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS learning_signal_candidate_outcome (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  learning_signal_id uuid NOT NULL REFERENCES learning_signal(id) ON DELETE CASCADE,

  eligibility varchar(24) NOT NULL
    CHECK (eligibility IN (
      'eligible', 'insufficient_evidence', 'negative_feedback_only', 'duplicate',
      'unsupported_scope', 'ai_only', 'blocked_by_policy'
    )),
  reason varchar(240) NOT NULL,

  -- Set only when eligibility = 'eligible' and a memory_candidate was
  -- actually created (or an existing duplicate-linked one was reused).
  -- ON DELETE SET NULL: this row's job is analytics/audit of the DECISION,
  -- not lifecycle-tracking of the candidate itself (memory_transition_audit
  -- already owns that once the candidate exists).
  memory_candidate_id uuid NULL REFERENCES memory_candidate(id) ON DELETE SET NULL,

  decided_at timestamptz NOT NULL DEFAULT now(),

  -- Single-column unique (not (tenant_id, learning_signal_id)): learning_signal_id
  -- already implies exactly one tenant, and Prisma's one-to-one relation on the
  -- LearningSignal side requires the FK field itself to be @unique.
  CONSTRAINT learning_signal_candidate_outcome_signal_unique UNIQUE (learning_signal_id),
  CONSTRAINT learning_signal_candidate_outcome_candidate_requires_eligible CHECK (
    memory_candidate_id IS NULL OR eligibility = 'eligible'
  )
);

CREATE INDEX IF NOT EXISTS learning_signal_candidate_outcome_tenant_eligibility_idx
  ON learning_signal_candidate_outcome (tenant_id, eligibility, decided_at DESC);

-- Same RLS convention as learning_signal itself (20261212010000): the
-- canonical current_tenant_id()/rls_bypass() helpers from
-- 20260501000000_init_identity_tenancy, not the app.tenant_id GUC.
ALTER TABLE learning_signal_candidate_outcome ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning_signal_candidate_outcome FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS learning_signal_candidate_outcome_tenant_isolation ON learning_signal_candidate_outcome;
CREATE POLICY learning_signal_candidate_outcome_tenant_isolation ON learning_signal_candidate_outcome
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT ON learning_signal_candidate_outcome TO capiro_app;
  END IF;
END $$;
