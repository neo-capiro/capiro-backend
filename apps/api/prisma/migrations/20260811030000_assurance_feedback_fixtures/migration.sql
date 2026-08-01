-- ===========================================================================
-- Assurance: the REVIEWED + ANONYMIZED feedback-to-eval-fixture workflow.
--
-- WHY. packages/meriv2-core/src/assurance/feedback-fixtures.ts encodes the right
-- rule — feedback never becomes golden truth automatically; acceptance requires a
-- NAMED reviewer plus completed anonymization — and nothing calls it. Meanwhile the
-- live path stores a thumbs-down in clio_message.metadata.feedback and
-- exportFeedbackForEvaluation ships a raw 1200-character response excerpt with no
-- anonymization and no review step.
--
-- The load-bearing in-code invariants are restated as DB CHECK constraints, because
-- once a table exists the constraints are the only thing that still holds when a
-- future route writes rows directly:
--   * a decided candidate must name its reviewer, time and reason;
--   * an ACCEPTED candidate must be anonymized AND carry an anonymization version;
--   * the reviewer must not be the person who created the candidate.
--
-- `summary` is reviewer-facing only and bounded. Prompt and response BODIES are
-- deliberately absent from both tables: a fixture references a trace and a claim
-- ledger hash, it does not store the conversation.
--
-- Additive only. No backfill of existing clio_message feedback.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- (1) A candidate raised from real feedback, pending human review.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assurance_feedback_candidate (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  status varchar(16) NOT NULL DEFAULT 'pending_review',
  reason_codes text[] NOT NULL,
  surface varchar(64) NOT NULL,
  -- The thumbs-down this came from. No FK: the candidate is evidence and must
  -- outlive a deleted conversation.
  source_message_id uuid,
  trace_id varchar(160),
  context_packet_id uuid,
  claim_ledger_hash varchar(128),
  -- Reviewer-facing description ONLY. Never a prompt or response body.
  summary text,
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  anonymized boolean NOT NULL DEFAULT false,
  anonymization_version varchar(80),
  reviewed_by_user_id uuid,
  reviewed_at timestamptz,
  review_reason text,
  fixture_id varchar(64),
  CONSTRAINT assurance_feedback_candidate_status_check CHECK (
    status IN ('pending_review','accepted','rejected')
  ),
  -- CANONICAL vocabulary, matching apps/api's FEEDBACK_REASON_CODES (the spelling
  -- already persisted in clio_message.metadata). Mirrors the
  -- memory_access_grant_permissions_check idiom.
  CONSTRAINT assurance_feedback_candidate_reason_codes_check CHECK (
    array_length(reason_codes, 1) >= 1
    AND reason_codes <@ ARRAY[
      'factually_wrong','outdated','wrong_client_context','missed_source',
      'unsupported_claim','too_generic','bad_recommendation','wrong_tone_or_format',
      'compliance_concern','tool_or_action_failed'
    ]::text[]
  ),
  CONSTRAINT assurance_feedback_candidate_summary_size_check CHECK (
    summary IS NULL OR octet_length(summary) <= 1000
  ),
  -- A decided candidate must say WHO decided it, WHEN, and WHY.
  CONSTRAINT assurance_feedback_candidate_review_attribution_check CHECK (
    status = 'pending_review' OR (
      reviewed_by_user_id IS NOT NULL
      AND reviewed_at IS NOT NULL
      AND review_reason IS NOT NULL
    )
  ),
  -- DB restatement of reviewFeedbackFixtureCandidate: accepted feedback must have
  -- been anonymized, under a named anonymization version.
  CONSTRAINT assurance_feedback_candidate_anonymized_check CHECK (
    status <> 'accepted' OR (anonymized AND anonymization_version IS NOT NULL)
  ),
  -- Segregation of duties: you cannot promote your own feedback to golden truth.
  CONSTRAINT assurance_feedback_candidate_reviewer_distinct_check CHECK (
    reviewed_by_user_id IS NULL OR reviewed_by_user_id <> created_by_user_id
  )
);
CREATE INDEX IF NOT EXISTS assurance_feedback_candidate_queue_idx
  ON assurance_feedback_candidate (tenant_id, status, created_at DESC);
-- One candidate per thumbs-down, so a repeated click cannot flood the queue.
CREATE UNIQUE INDEX IF NOT EXISTS assurance_feedback_candidate_message_unique
  ON assurance_feedback_candidate (tenant_id, source_message_id)
  WHERE source_message_id IS NOT NULL;

ALTER TABLE assurance_feedback_candidate ENABLE ROW LEVEL SECURITY;
ALTER TABLE assurance_feedback_candidate FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS assurance_feedback_candidate_tenant_isolation ON assurance_feedback_candidate;
CREATE POLICY assurance_feedback_candidate_tenant_isolation ON assurance_feedback_candidate
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- ---------------------------------------------------------------------------
-- (2) The ACCEPTED regression fixture. ON DELETE RESTRICT on the source candidate:
--     a fixture must never become unattributable by deleting its provenance.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assurance_eval_fixture (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- The deterministic 'feedback-<sha>' key. This is what
  -- assurance_eval_result.case_id references, so a failing eval traces back to the
  -- feedback that created it.
  fixture_key varchar(64) NOT NULL,
  source_candidate_id uuid NOT NULL
    REFERENCES assurance_feedback_candidate(id) ON DELETE RESTRICT,
  dataset_version varchar(120) NOT NULL,
  category varchar(40) NOT NULL,
  surface varchar(64) NOT NULL,
  trace_ref varchar(160),
  context_packet_ref varchar(160),
  claim_ledger_hash varchar(128),
  anonymization_version varchar(80) NOT NULL,
  accepted_by_user_id uuid NOT NULL,
  accepted_at timestamptz NOT NULL,
  retired_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS assurance_eval_fixture_key_unique
  ON assurance_eval_fixture (tenant_id, fixture_key);
CREATE INDEX IF NOT EXISTS assurance_eval_fixture_dataset_idx
  ON assurance_eval_fixture (tenant_id, dataset_version, retired_at);

ALTER TABLE assurance_eval_fixture ENABLE ROW LEVEL SECURITY;
ALTER TABLE assurance_eval_fixture FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS assurance_eval_fixture_tenant_isolation ON assurance_eval_fixture;
CREATE POLICY assurance_eval_fixture_tenant_isolation ON assurance_eval_fixture
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- No explicit GRANTs: capiro_app is covered by ALTER DEFAULT PRIVILEGES.
