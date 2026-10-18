-- Meri unattended routine firing (D016-A item 5), reserved and NOT applied.
-- Runs in the deployment packet after 20281018030000_clio_meri_routine_authority.
--
-- 1. Lifts the DB fence that kept every routine approval from authorizing
--    unattended work (the fence was to be lifted only by this migration).
-- 2. Records the consent: the routine owner's signed-in approval of one exact
--    schedule intent (Meri's attended Execute at wire A `before_claim`), at
--    most 30 days, renewed only by another signed-in approval.
-- 3. Records schedule revocations: an attended pause or delete (or an update
--    to a non-active projection) ends every earlier consent for the schedule.
-- 4. Records one ledger row per firing grant (wire C) before signing.
-- Only digests, claims and limits are stored, never a bearer token.

ALTER TABLE "clio_meri_routine_approvals" DROP CONSTRAINT "clio_meri_routine_approvals_unattended_fence";

CREATE TABLE "clio_meri_routine_consents" (
  "consent_id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "owner_user_id" UUID NOT NULL,
  "schedule_id" UUID NOT NULL,
  "intent_id" UUID NOT NULL,
  "generation" INTEGER NOT NULL,
  "intent_sha256" CHAR(64) NOT NULL,
  "projection_sha256" CHAR(64) NOT NULL,
  "decision_sha256" CHAR(64) NOT NULL,
  "scopes" JSONB NOT NULL,
  "limits" JSONB NOT NULL,
  "policy_revision" VARCHAR(128) NOT NULL,
  "issued_at" TIMESTAMPTZ(3) NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "clio_meri_routine_consents_pkey" PRIMARY KEY ("consent_id"),
  CONSTRAINT "clio_meri_routine_consents_decision_key" UNIQUE ("tenant_id", "intent_id", "decision_sha256"),
  CONSTRAINT "clio_meri_routine_consents_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "clio_meri_routine_consents_sha_check" CHECK (
    "intent_sha256" ~ '^[0-9a-f]{64}$' AND "projection_sha256" ~ '^[0-9a-f]{64}$' AND "decision_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "clio_meri_routine_consents_generation_check" CHECK ("generation" >= 1),
  -- D016-A item 5: at most 30 days.
  CONSTRAINT "clio_meri_routine_consents_window_check" CHECK (
    "expires_at" > "issued_at" AND "expires_at" <= "issued_at" + INTERVAL '30 days')
);
CREATE INDEX "clio_meri_routine_consents_lookup_idx"
  ON "clio_meri_routine_consents" ("tenant_id", "schedule_id", "generation", "intent_sha256", "projection_sha256", "issued_at");

CREATE TABLE "clio_meri_routine_consent_revocations" (
  "tenant_id" UUID NOT NULL,
  "intent_id" UUID NOT NULL,
  "schedule_id" UUID NOT NULL,
  "revoked_by_user_id" UUID NOT NULL,
  "reason" VARCHAR(16) NOT NULL,
  "revoked_at" TIMESTAMPTZ(3) NOT NULL,
  "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "clio_meri_routine_consent_revocations_pkey" PRIMARY KEY ("tenant_id", "intent_id"),
  CONSTRAINT "clio_meri_routine_consent_revocations_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "clio_meri_routine_consent_revocations_reason_check" CHECK ("reason" IN ('paused', 'deleted'))
);
CREATE INDEX "clio_meri_routine_consent_revocations_schedule_idx"
  ON "clio_meri_routine_consent_revocations" ("tenant_id", "schedule_id", "revoked_at");

CREATE TABLE "clio_meri_routine_fire_grants" (
  "jti" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "consent_id" UUID NOT NULL,
  "schedule_id" UUID NOT NULL,
  "generation" INTEGER NOT NULL,
  "occurrence_key" CHAR(64) NOT NULL,
  "phase" VARCHAR(32) NOT NULL,
  "signer_issuer" VARCHAR(256) NOT NULL,
  "signer_key_id" VARCHAR(64) NOT NULL,
  "iat_seconds" BIGINT NOT NULL,
  "exp_seconds" BIGINT NOT NULL,
  "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "clio_meri_routine_fire_grants_pkey" PRIMARY KEY ("jti"),
  CONSTRAINT "clio_meri_routine_fire_grants_consent_fkey"
    FOREIGN KEY ("consent_id") REFERENCES "clio_meri_routine_consents" ("consent_id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "clio_meri_routine_fire_grants_phase_check" CHECK ("phase" IN ('before_admission', 'before_start', 'before_stop')),
  CONSTRAINT "clio_meri_routine_fire_grants_key_check" CHECK ("occurrence_key" ~ '^[0-9a-f]{64}$' AND "signer_key_id" ~ '^[A-Za-z0-9._-]{1,64}$'),
  CONSTRAINT "clio_meri_routine_fire_grants_time_check" CHECK (
    "iat_seconds" BETWEEN 0 AND 253402300799 AND "exp_seconds" > "iat_seconds" AND "exp_seconds" - "iat_seconds" <= 30)
);

CREATE FUNCTION clio_meri_routine_unattended_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Meri routine consent, revocation and grant rows are immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER clio_meri_routine_consents_immutable BEFORE UPDATE ON "clio_meri_routine_consents"
  FOR EACH ROW EXECUTE FUNCTION clio_meri_routine_unattended_immutable();
CREATE TRIGGER clio_meri_routine_consent_revocations_immutable BEFORE UPDATE ON "clio_meri_routine_consent_revocations"
  FOR EACH ROW EXECUTE FUNCTION clio_meri_routine_unattended_immutable();
CREATE TRIGGER clio_meri_routine_fire_grants_immutable BEFORE UPDATE ON "clio_meri_routine_fire_grants"
  FOR EACH ROW EXECUTE FUNCTION clio_meri_routine_unattended_immutable();

ALTER TABLE "clio_meri_routine_consents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "clio_meri_routine_consents" FORCE ROW LEVEL SECURITY;
CREATE POLICY "clio_meri_routine_consents_isolation" ON "clio_meri_routine_consents"
  USING (rls_bypass() OR tenant_id = current_tenant_id()) WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
ALTER TABLE "clio_meri_routine_consent_revocations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "clio_meri_routine_consent_revocations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "clio_meri_routine_consent_revocations_isolation" ON "clio_meri_routine_consent_revocations"
  USING (rls_bypass() OR tenant_id = current_tenant_id()) WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
ALTER TABLE "clio_meri_routine_fire_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "clio_meri_routine_fire_grants" FORCE ROW LEVEL SECURITY;
CREATE POLICY "clio_meri_routine_fire_grants_isolation" ON "clio_meri_routine_fire_grants"
  USING (rls_bypass() OR tenant_id = current_tenant_id()) WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "clio_meri_routine_consents" FROM capiro_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON "clio_meri_routine_consent_revocations" FROM capiro_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON "clio_meri_routine_fire_grants" FROM capiro_app;
    GRANT SELECT, INSERT ON "clio_meri_routine_consents" TO capiro_app;
    GRANT SELECT, INSERT ON "clio_meri_routine_consent_revocations" TO capiro_app;
    GRANT SELECT, INSERT ON "clio_meri_routine_fire_grants" TO capiro_app;
  END IF;
END $$;
