-- Meri approved-execution authority (D016 #9), reserved and NOT applied.
--
-- The issuance ledger holds one row per capability (jti) issued for a stored
-- R12 approval.
--
-- The consumption ledger holds one durable effect identity per (tenant,
-- proposal, idempotency key). The receiver claims it, writes the task and
-- completes it with the result in ONE transaction, so a claimed row without a
-- result never commits; if one is ever read it is UNKNOWN and is never
-- redispatched.
--
-- Only digests, claims, the allocation hash and qualification facts read from
-- Meri's run owner, and the tool result are stored, never a bearer token.

-- Decision revocation (dot #121 6247742665 item 1): the R12 decision stays
-- immutable; a revocation is a separate append-only fact. Once a row exists,
-- `approval/decision` answers `revoked: true` and no capability is issued,
-- received or replayed for that proposal.
CREATE TABLE "clio_meri_approval_revocations" (
  "tenant_id" UUID NOT NULL,
  "proposal_id" UUID NOT NULL,
  "command_sha256" CHAR(64) NOT NULL,
  "revoked_by_user_id" UUID NOT NULL,
  "reason" VARCHAR(32) NOT NULL,
  "revoked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "clio_meri_approval_revocations_pkey" PRIMARY KEY ("tenant_id", "proposal_id"),
  CONSTRAINT "clio_meri_approval_revocations_decision_fkey"
    FOREIGN KEY ("tenant_id", "proposal_id")
    REFERENCES "clio_meri_approval_decisions" ("tenant_id", "proposal_id")
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "clio_meri_approval_revocations_sha_check" CHECK ("command_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "clio_meri_approval_revocations_reason_check" CHECK ("reason" IN ('approver_revoked'))
);

CREATE TABLE "clio_meri_execution_issuances" (
  "jti" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "proposal_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "attempt_id" UUID NOT NULL,
  "request_id" UUID NOT NULL,
  "request_sha256" CHAR(64) NOT NULL,
  "command_sha256" CHAR(64) NOT NULL,
  "decision_sha256" CHAR(64) NOT NULL,
  "arguments_sha256" CHAR(64) NOT NULL,
  "idempotency_key" VARCHAR(128) NOT NULL,
  "executor_binding" JSONB NOT NULL,
  "budgets" JSONB NOT NULL,
  "allocation_sha256" CHAR(64) NOT NULL,
  "qualification" JSONB NOT NULL,
  "signer_issuer" VARCHAR(256) NOT NULL,
  "signer_key_id" VARCHAR(64) NOT NULL,
  "iat_seconds" BIGINT NOT NULL,
  "exp_seconds" BIGINT NOT NULL,
  "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "clio_meri_execution_issuances_pkey" PRIMARY KEY ("jti"),
  CONSTRAINT "clio_meri_execution_issuances_decision_fkey"
    FOREIGN KEY ("tenant_id", "proposal_id")
    REFERENCES "clio_meri_approval_decisions" ("tenant_id", "proposal_id")
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "clio_meri_execution_issuances_sha_check" CHECK (
    "request_sha256" ~ '^[0-9a-f]{64}$' AND "command_sha256" ~ '^[0-9a-f]{64}$'
    AND "decision_sha256" ~ '^[0-9a-f]{64}$' AND "arguments_sha256" ~ '^[0-9a-f]{64}$'
    AND "allocation_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "clio_meri_execution_issuances_kid_check" CHECK ("signer_key_id" ~ '^[A-Za-z0-9._-]{1,64}$'),
  CONSTRAINT "clio_meri_execution_issuances_time_check" CHECK (
    "iat_seconds" BETWEEN 1 AND 253402300799 AND "exp_seconds" > "iat_seconds"
    AND "exp_seconds" - "iat_seconds" <= 120)
);
CREATE INDEX "clio_meri_execution_issuances_attempt_idx"
  ON "clio_meri_execution_issuances" ("tenant_id", "proposal_id", "run_id", "attempt_id", "iat_seconds");

CREATE TABLE "clio_meri_execution_consumptions" (
  "tenant_id" UUID NOT NULL,
  "proposal_id" UUID NOT NULL,
  "idempotency_key" VARCHAR(128) NOT NULL,
  "command_sha256" CHAR(64) NOT NULL,
  "arguments_sha256" CHAR(64) NOT NULL,
  "jti" UUID NOT NULL,
  "state" VARCHAR(9) NOT NULL DEFAULT 'CLAIMED',
  "result" JSONB,
  "claimed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  "completed_at" TIMESTAMPTZ(6),
  CONSTRAINT "clio_meri_execution_consumptions_pkey" PRIMARY KEY ("tenant_id", "proposal_id", "idempotency_key"),
  CONSTRAINT "clio_meri_execution_consumptions_jti_fkey"
    FOREIGN KEY ("jti") REFERENCES "clio_meri_execution_issuances" ("jti") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "clio_meri_execution_consumptions_state_check" CHECK (
    ("state" = 'CLAIMED' AND "result" IS NULL AND "completed_at" IS NULL)
    OR ("state" = 'COMPLETED' AND "result" IS NOT NULL AND "completed_at" IS NOT NULL))
);

CREATE FUNCTION clio_meri_execution_issuance_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Meri execution authority rows are immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER clio_meri_execution_issuances_immutable
  BEFORE UPDATE ON "clio_meri_execution_issuances"
  FOR EACH ROW EXECUTE FUNCTION clio_meri_execution_issuance_immutable();

-- The only permitted update: CLAIMED -> COMPLETED with its result, once.
CREATE FUNCTION clio_meri_execution_consumption_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state <> 'CLAIMED' OR NEW.state <> 'COMPLETED'
     OR NEW.tenant_id <> OLD.tenant_id OR NEW.proposal_id <> OLD.proposal_id
     OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.command_sha256 <> OLD.command_sha256
     OR NEW.arguments_sha256 <> OLD.arguments_sha256 OR NEW.jti <> OLD.jti OR NEW.claimed_at <> OLD.claimed_at THEN
    RAISE EXCEPTION 'Meri execution consumption may only complete once' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER clio_meri_execution_consumptions_transition
  BEFORE UPDATE ON "clio_meri_execution_consumptions"
  FOR EACH ROW EXECUTE FUNCTION clio_meri_execution_consumption_transition();

CREATE TRIGGER clio_meri_approval_revocations_immutable
  BEFORE UPDATE ON "clio_meri_approval_revocations"
  FOR EACH ROW EXECUTE FUNCTION clio_meri_execution_issuance_immutable();

ALTER TABLE "clio_meri_approval_revocations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "clio_meri_approval_revocations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "clio_meri_approval_revocations_isolation" ON "clio_meri_approval_revocations"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
ALTER TABLE "clio_meri_execution_issuances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "clio_meri_execution_issuances" FORCE ROW LEVEL SECURITY;
CREATE POLICY "clio_meri_execution_issuances_isolation" ON "clio_meri_execution_issuances"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
ALTER TABLE "clio_meri_execution_consumptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "clio_meri_execution_consumptions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "clio_meri_execution_consumptions_isolation" ON "clio_meri_execution_consumptions"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "clio_meri_approval_revocations" FROM capiro_app;
    GRANT SELECT, INSERT ON "clio_meri_approval_revocations" TO capiro_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON "clio_meri_execution_issuances" FROM capiro_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON "clio_meri_execution_consumptions" FROM capiro_app;
    GRANT SELECT, INSERT ON "clio_meri_execution_issuances" TO capiro_app;
    GRANT SELECT, INSERT ON "clio_meri_execution_consumptions" TO capiro_app;
    GRANT UPDATE ("state", "result", "completed_at") ON "clio_meri_execution_consumptions" TO capiro_app;
  END IF;
END $$;
