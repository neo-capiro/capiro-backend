-- DRAFT item 5 (Meri routines), reserved and NOT applied. Same pattern as the
-- Objective workload delegation: an immutable consent row, a DB fence that
-- keeps it from authorizing unattended work, an issuance ledger, RLS and
-- insert-only grants. No issuer, key or route is enabled by this migration.

-- The routine owner's approval of one exact schedules-0.2 intent (the
-- consent row). It records what the human approved, bound by Meri's own
-- RFC 8785 intent digest and the approving decision digest. The
-- unattended_enabled=false fence keeps every row from authorizing unattended
-- firing: that needs the held routine-grant contract and new owner policy,
-- and a later reviewed migration to lift the fence.
CREATE TABLE "clio_meri_routine_approvals" (
  "tenant_id" UUID NOT NULL,
  "intent_id" UUID NOT NULL,
  "owner_user_id" UUID NOT NULL,
  "schedule_id" UUID NOT NULL,
  "operation" VARCHAR(32) NOT NULL,
  "intent_sha256" CHAR(64) NOT NULL,
  "decision_sha256" CHAR(64) NOT NULL,
  "policy_revision" VARCHAR(128) NOT NULL,
  "decided_at" TIMESTAMPTZ(3) NOT NULL,
  "decision_expires_at" TIMESTAMPTZ(3) NOT NULL,
  "unattended_enabled" BOOLEAN NOT NULL DEFAULT false,
  "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "clio_meri_routine_approvals_pkey" PRIMARY KEY ("tenant_id", "intent_id"),
  CONSTRAINT "clio_meri_routine_approvals_intent_key" UNIQUE ("tenant_id", "intent_id", "intent_sha256"),
  CONSTRAINT "clio_meri_routine_approvals_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "clio_meri_routine_approvals_operation_check"
    CHECK ("operation" IN ('schedule_task', 'update_scheduled_task', 'cancel_scheduled_task')),
  CONSTRAINT "clio_meri_routine_approvals_sha_check"
    CHECK ("intent_sha256" ~ '^[0-9a-f]{64}$' AND "decision_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "clio_meri_routine_approvals_window_check" CHECK ("decision_expires_at" > "decided_at"),
  CONSTRAINT "clio_meri_routine_approvals_unattended_fence" CHECK ("unattended_enabled" = false)
);

-- One row per issued cancellation proof (jti). It is never released for reuse:
-- the FK has no cascade, so deleting an approval cannot free its proofs. Only
-- claims and digests are kept, never the bearer token.
CREATE TABLE "clio_meri_routine_cancel_proofs" (
  "jti" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "intent_id" UUID NOT NULL,
  "intent_sha256" CHAR(64) NOT NULL,
  "targets_sha256" CHAR(64) NOT NULL,
  "runs_sha256" CHAR(64) NOT NULL,
  "signer_issuer" VARCHAR(256) NOT NULL,
  "signer_key_id" VARCHAR(64) NOT NULL,
  "iat_seconds" BIGINT NOT NULL,
  "exp_seconds" BIGINT NOT NULL,
  "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "clio_meri_routine_cancel_proofs_pkey" PRIMARY KEY ("jti"),
  CONSTRAINT "clio_meri_routine_cancel_proofs_approval_fkey"
    FOREIGN KEY ("tenant_id", "intent_id", "intent_sha256")
    REFERENCES "clio_meri_routine_approvals" ("tenant_id", "intent_id", "intent_sha256")
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "clio_meri_routine_cancel_proofs_sha_check"
    CHECK ("targets_sha256" ~ '^[0-9a-f]{64}$' AND "runs_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "clio_meri_routine_cancel_proofs_kid_check" CHECK ("signer_key_id" ~ '^[A-Za-z0-9._-]{1,64}$'),
  -- Existing semantics: at most Meri's 30 s request bound.
  CONSTRAINT "clio_meri_routine_cancel_proofs_time_check"
    CHECK ("iat_seconds" BETWEEN 0 AND 253402300799 AND "exp_seconds" > "iat_seconds"
      AND "exp_seconds" - "iat_seconds" <= 30)
);
CREATE INDEX "clio_meri_routine_cancel_proofs_intent_idx"
  ON "clio_meri_routine_cancel_proofs" ("tenant_id", "intent_id");

CREATE FUNCTION clio_meri_routine_authority_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Meri routine authority rows are immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER clio_meri_routine_approvals_immutable
  BEFORE UPDATE ON "clio_meri_routine_approvals"
  FOR EACH ROW EXECUTE FUNCTION clio_meri_routine_authority_immutable();
CREATE TRIGGER clio_meri_routine_cancel_proofs_immutable
  BEFORE UPDATE ON "clio_meri_routine_cancel_proofs"
  FOR EACH ROW EXECUTE FUNCTION clio_meri_routine_authority_immutable();

ALTER TABLE "clio_meri_routine_approvals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "clio_meri_routine_approvals" FORCE ROW LEVEL SECURITY;
CREATE POLICY "clio_meri_routine_approvals_isolation" ON "clio_meri_routine_approvals"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
ALTER TABLE "clio_meri_routine_cancel_proofs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "clio_meri_routine_cancel_proofs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "clio_meri_routine_cancel_proofs_isolation" ON "clio_meri_routine_cancel_proofs"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "clio_meri_routine_approvals" FROM capiro_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON "clio_meri_routine_cancel_proofs" FROM capiro_app;
    GRANT SELECT, INSERT ON "clio_meri_routine_approvals" TO capiro_app;
    GRANT SELECT, INSERT ON "clio_meri_routine_cancel_proofs" TO capiro_app;
  END IF;
END $$;
