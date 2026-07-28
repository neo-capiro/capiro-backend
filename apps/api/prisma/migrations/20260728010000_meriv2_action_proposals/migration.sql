-- Phase 0: immutable server-created MeriV2 action proposal lifecycle.
-- Additive only: historical meri_action_approval / meri_pending_action rows remain readable.

CREATE TABLE "meri_action_proposals" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "actor_user_id" UUID,
  "impersonation_session_id" VARCHAR(160),
  "conversation_id" UUID,
  "surface" VARCHAR(40) NOT NULL,
  "tool" VARCHAR(120) NOT NULL,
  "input_jsonb" JSONB NOT NULL,
  "fingerprint" VARCHAR(64) NOT NULL,
  "policy_version" VARCHAR(80) NOT NULL,
  "policy_rule_id" VARCHAR(160),
  "policy_decision" VARCHAR(20) NOT NULL,
  "policy_code" VARCHAR(120),
  "risk_tier" VARCHAR(40),
  "preview_jsonb" JSONB NOT NULL,
  "status" VARCHAR(32) NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "approved_at" TIMESTAMPTZ(6),
  "approved_by" UUID,
  "execution_started_at" TIMESTAMPTZ(6),
  "executed_at" TIMESTAMPTZ(6),
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "last_error_code" VARCHAR(120),
  "last_error_message" VARCHAR(1000),
  "result_summary_jsonb" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "meri_action_proposals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "meri_action_proposals_status_check" CHECK ("status" IN (
    'proposed','approved','executing','succeeded','failed_retryable',
    'failed_terminal','outcome_unknown','blocked','dismissed','expired'
  )),
  CONSTRAINT "meri_action_proposals_policy_decision_check" CHECK ("policy_decision" IN ('PASS','WARN','BLOCK')),
  CONSTRAINT "meri_action_proposals_fingerprint_check" CHECK ("fingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "meri_action_proposals_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "meri_action_proposal_user_status_created_idx"
  ON "meri_action_proposals"("tenant_id", "user_id", "status", "created_at" DESC);
CREATE INDEX "meri_action_proposal_conversation_status_idx"
  ON "meri_action_proposals"("conversation_id", "status");
CREATE INDEX "meri_action_proposal_expiry_status_idx"
  ON "meri_action_proposals"("expires_at", "status");
CREATE INDEX "meri_action_proposal_tenant_fingerprint_idx"
  ON "meri_action_proposals"("tenant_id", "fingerprint");

ALTER TABLE "meri_action_proposals" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "meri_action_proposals_tenant_isolation" ON "meri_action_proposals"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

COMMENT ON TABLE "meri_action_proposals" IS
  'Immutable MeriV2 action proposals. Application-level tenant/user predicates remain mandatory because the application role may bypass owner RLS.';
COMMENT ON COLUMN "meri_action_proposals"."preview_jsonb" IS
  'Display-only informed-consent summary; never an execution authority.';
