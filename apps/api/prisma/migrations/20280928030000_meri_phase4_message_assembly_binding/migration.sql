-- Phase 4 v2 source-message/outbound-assembly binding. The v1 package was
-- dormant. Never reinterpret a v1 identity: any row requires exact, explicit
-- reconciliation before this transition can proceed.
DO $$
BEGIN
  PERFORM set_config('row_security', 'off', true);
  IF EXISTS (SELECT 1 FROM "meri_agent_dispatch_intents" LIMIT 1) THEN
    RAISE EXCEPTION
      'dispatch v1 rows require explicit reconciliation before the v2 identity transition'
      USING ERRCODE = '55000';
  END IF;
END
$$;

ALTER TABLE "meri_agent_dispatch_intents"
  DROP CONSTRAINT "meri_agent_dispatch_intents_identity_shape_check",
  ADD COLUMN "source_message_sha256" CHAR(64) NOT NULL,
  ADD COLUMN "request_assembly_sha256" CHAR(64) NOT NULL,
  ADD CONSTRAINT "meri_agent_dispatch_intents_message_assembly_digest_check" CHECK (
    "source_message_sha256" ~ '^[0-9a-f]{64}$' AND
    "request_assembly_sha256" ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT "meri_agent_dispatch_intents_identity_shape_check" CHECK (
    "identity_version" = 2 AND
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
  );

-- Enforce the late-clock freshness invariant again in the database at the
-- exact intent insert. This closes process scheduling time between the shared
-- transaction's clock sample and its final prepared-intent write.
CREATE FUNCTION meri_phase4_dispatch_binding_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  db_now TIMESTAMPTZ;
  db_now_epoch_micros BIGINT;
  envelope_issued_epoch_micros BIGINT;
  envelope_expires_epoch_micros BIGINT;
  reservation_period_date DATE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    db_now := clock_timestamp();
    db_now_epoch_micros :=
      floor(extract(epoch FROM db_now) * 1000000)::BIGINT;

    SELECT
      floor(extract(epoch FROM ((r.envelope_jsonb->>'issuedAt')::timestamptz)) * 1000000)::BIGINT,
      floor(extract(epoch FROM ((r.envelope_jsonb->>'expiresAt')::timestamptz)) * 1000000)::BIGINT,
      rr.period_date
    INTO envelope_issued_epoch_micros, envelope_expires_epoch_micros, reservation_period_date
    FROM meri_agent_runs r
    JOIN meri_agent_run_reservations rr
      ON rr.tenant_id = r.tenant_id AND rr.run_id = r.id
    WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.run_id;

    IF NEW.identity_version <> 2 OR
       envelope_issued_epoch_micros IS NULL OR envelope_expires_epoch_micros IS NULL OR
       reservation_period_date IS NULL OR
       reservation_period_date <> (db_now AT TIME ZONE 'UTC')::date OR
       envelope_issued_epoch_micros > db_now_epoch_micros OR
       db_now_epoch_micros >= envelope_expires_epoch_micros OR
       db_now_epoch_micros >= NEW.claim_not_after_epoch_micros OR
       db_now_epoch_micros >= NEW.delivery_not_after_epoch_micros OR
       db_now_epoch_micros >= NEW.worker_credential_not_after_epoch_micros OR
       NEW.claim_not_after_epoch_micros > envelope_expires_epoch_micros OR
       NEW.delivery_not_after_epoch_micros > envelope_expires_epoch_micros THEN
      RAISE EXCEPTION 'dispatch v2 freshness window is closed'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.source_message_sha256 IS DISTINCT FROM OLD.source_message_sha256 OR
     NEW.request_assembly_sha256 IS DISTINCT FROM OLD.request_assembly_sha256 THEN
    RAISE EXCEPTION 'dispatch message/assembly binding is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER meri_phase4_dispatch_binding_guard_trigger
  BEFORE INSERT OR UPDATE ON "meri_agent_dispatch_intents"
  FOR EACH ROW EXECUTE FUNCTION meri_phase4_dispatch_binding_guard();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT INSERT (source_message_sha256, request_assembly_sha256)
      ON TABLE "meri_agent_dispatch_intents" TO capiro_app;
  END IF;
END
$$;

COMMENT ON COLUMN "meri_agent_dispatch_intents"."source_message_sha256" IS
  'V2 content-free digest of exact persisted user-message body, ids, role, and canonical JSON provenance.';
COMMENT ON COLUMN "meri_agent_dispatch_intents"."request_assembly_sha256" IS
  'V2 content-free digest binding source_message_sha256 to exact outbound body length/hash.';
