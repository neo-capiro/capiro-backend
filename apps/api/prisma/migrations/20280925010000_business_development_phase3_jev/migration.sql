-- Business Development Phase 3 — additive, tenant-private Jev decision trace.
--
-- The trace is deliberately redacted: no prompts, passages, notes, conflict
-- reasons, contacts, preferences or PDL payloads are persisted. It retains
-- only hashes, public source ids, typed decisions, budgets and review state.

CREATE TABLE "business_development_jev_decisions" (
  "id"                       UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id"                UUID NOT NULL,
  "subject_type"             VARCHAR(24) NOT NULL,
  "subject_id"               VARCHAR(160) NOT NULL,
  "prospect_id"              UUID,
  "canonical_entity_id"      UUID,
  "task"                     VARCHAR(32) NOT NULL,
  "mode"                     VARCHAR(24) NOT NULL,
  "status"                   VARCHAR(24) NOT NULL,
  "operational_state"        VARCHAR(40),
  "provider_name"            VARCHAR(64) NOT NULL,
  "model_version"            VARCHAR(40) NOT NULL,
  "registry_version"         VARCHAR(64) NOT NULL,
  "question_version"         VARCHAR(64) NOT NULL,
  "envelope_hash"            VARCHAR(80) NOT NULL,
  "candidate_inventory_hash" VARCHAR(80),
  "source_ids"               TEXT[] NOT NULL DEFAULT '{}',
  "source_hashes_jsonb"      JSONB NOT NULL DEFAULT '[]'::jsonb,
  "deterministic_outcome"    VARCHAR(64),
  "outcome"                  VARCHAR(64),
  "probabilities_jsonb"      JSONB,
  "confidence"               DECIMAL(6,5),
  "reason_codes"             TEXT[] NOT NULL DEFAULT '{}',
  "input_tokens"             INTEGER,
  "output_tokens"            INTEGER,
  "estimated_cost_usd"       DECIMAL(12,9),
  "latency_ms"               INTEGER,
  "visible_effect_jsonb"     JSONB,
  "review_status"            VARCHAR(24) NOT NULL DEFAULT 'unreviewed',
  "reviewed_outcome"         VARCHAR(64),
  "reviewed_by_user_id"      UUID,
  "reviewed_at"              TIMESTAMPTZ(6),
  "idempotency_key"          VARCHAR(400) NOT NULL,
  "requested_at"             TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "completed_at"             TIMESTAMPTZ(6),
  "created_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "business_development_jev_decisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "business_development_jev_decisions_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "business_development_jev_decisions_subject_type_check"
    CHECK ("subject_type" IN ('prospect', 'company', 'signal')),
  CONSTRAINT "business_development_jev_decisions_task_check"
    CHECK ("task" IN ('bd_entity', 'bd_signal', 'bd_fit', 'bd_timing', 'bd_evidence', 'bd_claim')),
  CONSTRAINT "business_development_jev_decisions_mode_check"
    CHECK ("mode" IN ('shadow', 'internal_canary')),
  CONSTRAINT "business_development_jev_decisions_status_check"
    CHECK ("status" IN ('pending', 'completed', 'failed', 'skipped')),
  CONSTRAINT "business_development_jev_decisions_review_status_check"
    CHECK ("review_status" IN ('unreviewed', 'accepted', 'corrected', 'rejected')),
  CONSTRAINT "business_development_jev_decisions_confidence_check"
    CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1)),
  CONSTRAINT "business_development_jev_decisions_usage_check"
    CHECK (("input_tokens" IS NULL OR "input_tokens" >= 0)
       AND ("output_tokens" IS NULL OR "output_tokens" >= 0)
       AND ("latency_ms" IS NULL OR "latency_ms" >= 0)
       AND ("estimated_cost_usd" IS NULL OR "estimated_cost_usd" >= 0)),
  CONSTRAINT "business_development_jev_decisions_review_check"
    CHECK (("review_status" = 'unreviewed' AND "reviewed_at" IS NULL)
       OR ("review_status" <> 'unreviewed' AND "reviewed_at" IS NOT NULL)),
  CONSTRAINT "business_development_jev_decisions_shadow_invisible_check"
    CHECK ("mode" <> 'shadow' OR "visible_effect_jsonb" IS NULL)
);

CREATE UNIQUE INDEX "business_development_jev_decisions_tenant_idempotency_key"
  ON "business_development_jev_decisions"("tenant_id", "idempotency_key");
CREATE INDEX "business_development_jev_decisions_tenant_task_mode_idx"
  ON "business_development_jev_decisions"("tenant_id", "task", "mode", "requested_at" DESC);
CREATE INDEX "business_development_jev_decisions_tenant_subject_idx"
  ON "business_development_jev_decisions"("tenant_id", "subject_type", "subject_id", "requested_at" DESC);
CREATE INDEX "business_development_jev_decisions_tenant_review_idx"
  ON "business_development_jev_decisions"("tenant_id", "review_status", "requested_at" DESC);

ALTER TABLE "business_development_jev_decisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "business_development_jev_decisions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "business_development_jev_decisions_isolation" ON "business_development_jev_decisions"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "business_development_jev_decisions" TO capiro_app;
  END IF;
END
$$;
