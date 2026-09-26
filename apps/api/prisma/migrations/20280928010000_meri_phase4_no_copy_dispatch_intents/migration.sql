-- Phase 4 no-copy dispatch intent authority (dormant; no runtime route is
-- wired by this migration). The row deliberately has no foreign keys: normal
-- tenant/run/message cleanup must not cascade away a deduplication tombstone.
-- Exact source rows are locked and checked by the repository when preparing
-- or transitioning an intent.
CREATE TABLE "meri_agent_dispatch_intents" (
  "run_id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "identity_version" INTEGER NOT NULL,
  "actor_type" VARCHAR(16) NOT NULL,
  "actor_id" UUID NOT NULL,
  "meri_audience" VARCHAR(16) NOT NULL,
  "client_id" UUID,
  "workspace_id" UUID,
  "scope_id" VARCHAR(200) NOT NULL,
  "conversation_id" UUID NOT NULL,
  "user_message_id" UUID NOT NULL,
  "idempotency_key" VARCHAR(200) NOT NULL,
  "conversation_epoch" BIGINT NOT NULL,
  "worker_audience" TEXT NOT NULL,
  "worker_ingress_id" TEXT NOT NULL,
  "worker_generation" TEXT NOT NULL,
  "worker_credential_id" TEXT NOT NULL,
  "authorization_version" TEXT NOT NULL,
  "authorization_policy_version" TEXT NOT NULL,
  "grant_version" TEXT NOT NULL,
  "catalog_digest" CHAR(64) NOT NULL,
  "tool_view_digest" CHAR(64) NOT NULL,
  "session_header_key_id" TEXT NOT NULL,
  "claim_not_after_epoch_micros" BIGINT NOT NULL,
  "delivery_not_after_epoch_micros" BIGINT NOT NULL,
  "worker_credential_not_after_epoch_micros" BIGINT NOT NULL,
  "reconciliation_not_after_epoch_micros" BIGINT NOT NULL,
  "retain_until_epoch_micros" BIGINT NOT NULL,
  "body_length_bytes" BIGINT NOT NULL,
  "body_sha256" CHAR(64) NOT NULL,
  "session_header_hmac_sha256" CHAR(64) NOT NULL,
  "request_sha256" CHAR(64) NOT NULL,
  "state" VARCHAR(24) NOT NULL DEFAULT 'prepared',
  "worker_run_id" VARCHAR(120),
  "claimed_at_epoch_micros" BIGINT,
  "sealed_absent_at_epoch_micros" BIGINT,
  "absence_proof_sha256" CHAR(64),
  "tombstoned_at_epoch_micros" BIGINT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "meri_agent_dispatch_intents_pkey" PRIMARY KEY ("run_id"),
  CONSTRAINT "meri_agent_dispatch_intents_scope_idempotency_key"
    UNIQUE ("scope_id", "idempotency_key"),
  CONSTRAINT "meri_agent_dispatch_intents_tenant_user_message_key"
    UNIQUE ("tenant_id", "user_message_id"),
  CONSTRAINT "meri_agent_dispatch_intents_worker_run_id_key" UNIQUE ("worker_run_id"),
  CONSTRAINT "meri_agent_dispatch_intents_identity_shape_check" CHECK (
    "identity_version" = 1 AND
    "actor_type" = 'user' AND
    "meri_audience" = 'private' AND
    "idempotency_key" ~ '^[!-~]+$' AND
    length("worker_audience") > 0 AND btrim("worker_audience") = "worker_audience" AND
    length("worker_ingress_id") > 0 AND btrim("worker_ingress_id") = "worker_ingress_id" AND
    length("worker_generation") > 0 AND btrim("worker_generation") = "worker_generation" AND
    length("worker_credential_id") > 0 AND btrim("worker_credential_id") = "worker_credential_id" AND
    length("authorization_version") > 0 AND btrim("authorization_version") = "authorization_version" AND
    length("authorization_policy_version") > 0 AND
      btrim("authorization_policy_version") = "authorization_policy_version" AND
    length("grant_version") > 0 AND btrim("grant_version") = "grant_version" AND
    length("session_header_key_id") > 0 AND
      btrim("session_header_key_id") = "session_header_key_id" AND
    "conversation_epoch" >= 0 AND
    "conversation_epoch" <= 9007199254740991::BIGINT AND
    "body_length_bytes" > 0 AND
    "body_length_bytes" <= 9007199254740991::BIGINT AND
    "claim_not_after_epoch_micros" > 0 AND
    "delivery_not_after_epoch_micros" >= "claim_not_after_epoch_micros" AND
    "worker_credential_not_after_epoch_micros" >= "claim_not_after_epoch_micros" AND
    "reconciliation_not_after_epoch_micros" >=
      GREATEST("delivery_not_after_epoch_micros", "worker_credential_not_after_epoch_micros")
      + 86400000000::BIGINT AND
    "retain_until_epoch_micros" >=
      "reconciliation_not_after_epoch_micros" + 86400000000::BIGINT
  ),
  CONSTRAINT "meri_agent_dispatch_intents_digest_shape_check" CHECK (
    "catalog_digest" ~ '^[0-9a-f]{64}$' AND
    "tool_view_digest" ~ '^[0-9a-f]{64}$' AND
    "body_sha256" ~ '^[0-9a-f]{64}$' AND
    "session_header_hmac_sha256" ~ '^[0-9a-f]{64}$' AND
    "request_sha256" ~ '^[0-9a-f]{64}$' AND
    ("absence_proof_sha256" IS NULL OR "absence_proof_sha256" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "meri_agent_dispatch_intents_state_shape_check" CHECK (
    (
      "state" = 'prepared' AND
      "worker_run_id" IS NULL AND
      "claimed_at_epoch_micros" IS NULL AND
      "sealed_absent_at_epoch_micros" IS NULL AND
      "absence_proof_sha256" IS NULL
    ) OR (
      "state" = 'claimed' AND
      "worker_run_id" IS NOT NULL AND
      length("worker_run_id") > 0 AND
      btrim("worker_run_id") = "worker_run_id" AND
      "worker_run_id" !~ '[[:cntrl:]]' AND
      "claimed_at_epoch_micros" > 0 AND
      "sealed_absent_at_epoch_micros" IS NULL AND
      "absence_proof_sha256" IS NULL
    ) OR (
      "state" = 'sealed_absent' AND
      "worker_run_id" IS NULL AND
      "claimed_at_epoch_micros" IS NULL AND
      "sealed_absent_at_epoch_micros" > 0 AND
      "absence_proof_sha256" IS NOT NULL
    )
  ),
  CONSTRAINT "meri_agent_dispatch_intents_tombstone_check" CHECK (
    "tombstoned_at_epoch_micros" IS NULL OR (
      "state" IN ('claimed', 'sealed_absent') AND
      "tombstoned_at_epoch_micros" >= "retain_until_epoch_micros"
    )
  )
);

CREATE INDEX "meri_agent_dispatch_intents_tenant_state_claim_idx"
  ON "meri_agent_dispatch_intents"("tenant_id", "state", "claim_not_after_epoch_micros");
CREATE INDEX "meri_agent_dispatch_intents_tenant_retention_idx"
  ON "meri_agent_dispatch_intents"("tenant_id", "retain_until_epoch_micros");

-- The database, not a process clock, supplies every durable transition time.
-- Identity is immutable. UNKNOWN is intentionally absent from the state
-- machine: a lost commit/read response is an observation, never a row value.
CREATE FUNCTION meri_phase4_dispatch_intent_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  db_now_epoch_micros BIGINT;
BEGIN
  db_now_epoch_micros :=
    floor(extract(epoch FROM clock_timestamp()) * 1000000)::BIGINT;

  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'prepared' OR
       NEW.worker_run_id IS NOT NULL OR
       NEW.claimed_at_epoch_micros IS NOT NULL OR
       NEW.sealed_absent_at_epoch_micros IS NOT NULL OR
       NEW.absence_proof_sha256 IS NOT NULL OR
       NEW.tombstoned_at_epoch_micros IS NOT NULL THEN
      RAISE EXCEPTION 'dispatch intent must be inserted prepared'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'dispatch intent deletion is disabled'
      USING ERRCODE = '55000';
  END IF;

  IF ROW(
      NEW.run_id, NEW.tenant_id, NEW.identity_version,
      NEW.actor_type, NEW.actor_id, NEW.meri_audience,
      NEW.client_id, NEW.workspace_id, NEW.scope_id,
      NEW.conversation_id, NEW.user_message_id, NEW.idempotency_key,
      NEW.conversation_epoch, NEW.worker_audience, NEW.worker_ingress_id,
      NEW.worker_generation, NEW.worker_credential_id,
      NEW.authorization_version, NEW.authorization_policy_version,
      NEW.grant_version, NEW.catalog_digest, NEW.tool_view_digest,
      NEW.session_header_key_id, NEW.claim_not_after_epoch_micros,
      NEW.delivery_not_after_epoch_micros,
      NEW.worker_credential_not_after_epoch_micros,
      NEW.reconciliation_not_after_epoch_micros,
      NEW.retain_until_epoch_micros, NEW.body_length_bytes,
      NEW.body_sha256, NEW.session_header_hmac_sha256,
      NEW.request_sha256, NEW.created_at
    ) IS DISTINCT FROM ROW(
      OLD.run_id, OLD.tenant_id, OLD.identity_version,
      OLD.actor_type, OLD.actor_id, OLD.meri_audience,
      OLD.client_id, OLD.workspace_id, OLD.scope_id,
      OLD.conversation_id, OLD.user_message_id, OLD.idempotency_key,
      OLD.conversation_epoch, OLD.worker_audience, OLD.worker_ingress_id,
      OLD.worker_generation, OLD.worker_credential_id,
      OLD.authorization_version, OLD.authorization_policy_version,
      OLD.grant_version, OLD.catalog_digest, OLD.tool_view_digest,
      OLD.session_header_key_id, OLD.claim_not_after_epoch_micros,
      OLD.delivery_not_after_epoch_micros,
      OLD.worker_credential_not_after_epoch_micros,
      OLD.reconciliation_not_after_epoch_micros,
      OLD.retain_until_epoch_micros, OLD.body_length_bytes,
      OLD.body_sha256, OLD.session_header_hmac_sha256,
      OLD.request_sha256, OLD.created_at
    ) THEN
    RAISE EXCEPTION 'dispatch intent identity is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.state = 'prepared' AND NEW.state = 'claimed' THEN
    IF db_now_epoch_micros >= OLD.claim_not_after_epoch_micros OR
       NEW.worker_run_id IS NULL OR btrim(NEW.worker_run_id) = '' OR
       NEW.sealed_absent_at_epoch_micros IS NOT NULL OR
       NEW.absence_proof_sha256 IS NOT NULL OR
       NEW.tombstoned_at_epoch_micros IS NOT NULL THEN
      RAISE EXCEPTION 'dispatch claim is closed or malformed'
        USING ERRCODE = '55000';
    END IF;
    NEW.claimed_at_epoch_micros := db_now_epoch_micros;
    RETURN NEW;
  END IF;

  IF OLD.state = 'prepared' AND NEW.state = 'sealed_absent' THEN
    IF db_now_epoch_micros <= OLD.reconciliation_not_after_epoch_micros OR
       NEW.worker_run_id IS NOT NULL OR
       NEW.claimed_at_epoch_micros IS NOT NULL OR
       NEW.absence_proof_sha256 IS NULL OR
       NEW.absence_proof_sha256 !~ '^[0-9a-f]{64}$' OR
       NEW.tombstoned_at_epoch_micros IS NOT NULL THEN
      RAISE EXCEPTION 'dispatch absence cannot be sealed yet or is malformed'
        USING ERRCODE = '55000';
    END IF;
    NEW.sealed_absent_at_epoch_micros := db_now_epoch_micros;
    RETURN NEW;
  END IF;

  -- Retention marking is not a fourth admission state. It preserves the exact
  -- identity and outcome forever until a separately reviewed purge policy is
  -- installed. No purge/delete operation is part of this package.
  IF OLD.state IN ('claimed', 'sealed_absent') AND
     NEW.state = OLD.state AND
     OLD.tombstoned_at_epoch_micros IS NULL AND
     NEW.tombstoned_at_epoch_micros IS NOT NULL AND
     ROW(NEW.worker_run_id, NEW.claimed_at_epoch_micros,
         NEW.sealed_absent_at_epoch_micros, NEW.absence_proof_sha256)
       IS NOT DISTINCT FROM
       ROW(OLD.worker_run_id, OLD.claimed_at_epoch_micros,
           OLD.sealed_absent_at_epoch_micros, OLD.absence_proof_sha256) AND
     db_now_epoch_micros >= OLD.retain_until_epoch_micros THEN
    NEW.tombstoned_at_epoch_micros := db_now_epoch_micros;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'dispatch intent state transition is forbidden'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER meri_phase4_dispatch_intent_guard_trigger
  BEFORE INSERT OR UPDATE OR DELETE ON "meri_agent_dispatch_intents"
  FOR EACH ROW EXECUTE FUNCTION meri_phase4_dispatch_intent_guard();

ALTER TABLE "meri_agent_dispatch_intents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meri_agent_dispatch_intents" FORCE ROW LEVEL SECURITY;
CREATE POLICY "meri_agent_dispatch_intents_tenant_isolation"
  ON "meri_agent_dispatch_intents"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

REVOKE ALL ON TABLE "meri_agent_dispatch_intents" FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    -- The bootstrap role installs table-level default privileges on future
    -- tables. Revoke those broad grants before adding the narrower columns;
    -- a column GRANT alone does not override an existing table GRANT.
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
      ON TABLE "meri_agent_dispatch_intents" FROM capiro_app;
    GRANT SELECT ON TABLE "meri_agent_dispatch_intents" TO capiro_app;
    GRANT INSERT (
      run_id, tenant_id, identity_version, actor_type, actor_id,
      meri_audience, client_id, workspace_id, scope_id, conversation_id,
      user_message_id, idempotency_key, conversation_epoch, worker_audience,
      worker_ingress_id, worker_generation, worker_credential_id,
      authorization_version, authorization_policy_version, grant_version,
      catalog_digest, tool_view_digest, session_header_key_id,
      claim_not_after_epoch_micros, delivery_not_after_epoch_micros,
      worker_credential_not_after_epoch_micros,
      reconciliation_not_after_epoch_micros, retain_until_epoch_micros,
      body_length_bytes, body_sha256, session_header_hmac_sha256,
      request_sha256
    ) ON TABLE "meri_agent_dispatch_intents" TO capiro_app;
    GRANT UPDATE (
      state, worker_run_id, claimed_at_epoch_micros,
      sealed_absent_at_epoch_micros, absence_proof_sha256,
      tombstoned_at_epoch_micros
    ) ON TABLE "meri_agent_dispatch_intents" TO capiro_app;
  END IF;
END
$$;

COMMENT ON TABLE "meri_agent_dispatch_intents" IS
  'Dormant Phase 4 exact-request admission/absence authority; no body, session key, bearer, or HMAC key is persisted.';
COMMENT ON COLUMN "meri_agent_dispatch_intents"."tombstoned_at_epoch_micros" IS
  'Retention marker only; exact identity/outcome remain immutable and deletion remains disabled until a separately proven purge horizon exists.';
