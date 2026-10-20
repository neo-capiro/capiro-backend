-- P-INT-10 native approval decisions for Meri conversation write intents.
-- One immutable decision per (tenant, proposal); a repeat answers the stored
-- row. Conversation and run ids are Meri identifiers (no Core foreign key).
CREATE TABLE "clio_meri_approval_decisions" (
  "tenant_id" UUID NOT NULL,
  "proposal_id" UUID NOT NULL,
  "command_sha256" CHAR(64) NOT NULL,
  "decision" VARCHAR(8) NOT NULL,
  "decided_at" TIMESTAMPTZ(3) NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "approver_user_id" UUID NOT NULL,
  "policy_revision" VARCHAR(128) NOT NULL,
  "binding_actor_user_id" UUID NOT NULL,
  "conversation_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "clio_meri_approval_decisions_pkey" PRIMARY KEY ("tenant_id", "proposal_id"),
  CONSTRAINT "clio_meri_approval_decisions_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "clio_meri_approval_decisions_sha_check" CHECK ("command_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "clio_meri_approval_decisions_decision_check" CHECK ("decision" IN ('approved', 'rejected')),
  CONSTRAINT "clio_meri_approval_decisions_window_check" CHECK ("expires_at" > "decided_at"),
  CONSTRAINT "clio_meri_approval_decisions_owner_check" CHECK ("approver_user_id" = "binding_actor_user_id")
);

CREATE FUNCTION clio_meri_approval_decision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Meri approval decision is immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER clio_meri_approval_decision_immutable
  BEFORE UPDATE ON "clio_meri_approval_decisions"
  FOR EACH ROW EXECUTE FUNCTION clio_meri_approval_decision_immutable();

ALTER TABLE "clio_meri_approval_decisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "clio_meri_approval_decisions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "clio_meri_approval_decisions_isolation" ON "clio_meri_approval_decisions"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "clio_meri_approval_decisions" FROM capiro_app;
    GRANT SELECT, INSERT ON "clio_meri_approval_decisions" TO capiro_app;
  END IF;
END $$;
