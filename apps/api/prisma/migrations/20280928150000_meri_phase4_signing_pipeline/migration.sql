-- Phase 4 item 4: Qualified signing and verification pipeline
--
-- Creates the signing infrastructure tables and roles. The signer and
-- verifier are separate one-shot tasks with distinct DB credentials.
-- The API and ordinary broker/recovery/route roles get no signing-table DML.
--
-- Roles created:
--   meri_phase4_signing_key_admin  — manages key registry lifecycle
--   meri_phase4_broker_signer      — reads signing requests, writes signatures
-- Existing roles used:
--   meri_phase4_broker_signer_owner — verifier: reads public keys, writes attestations

-- ── Roles ──

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meri_phase4_signing_key_admin') THEN
    CREATE ROLE meri_phase4_signing_key_admin NOLOGIN NOSUPERUSER NOCREATEDB
      NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meri_phase4_broker_signer') THEN
    CREATE ROLE meri_phase4_broker_signer NOLOGIN NOSUPERUSER NOCREATEDB
      NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
  END IF;
END $$;

-- ── Key registry ──

CREATE TABLE IF NOT EXISTS meri_phase4_signing_key_registry (
  key_id         varchar(128) PRIMARY KEY,
  algorithm      varchar(16)  NOT NULL DEFAULT 'Ed25519'
    CHECK (algorithm = 'Ed25519'),
  public_key_spki_der  bytea NOT NULL
    CHECK (octet_length(public_key_spki_der) >= 32 AND
           octet_length(public_key_spki_der) <= 512),
  public_key_spki_sha256 char(64) NOT NULL
    CHECK (public_key_spki_sha256 ~ '^[0-9a-f]{64}$'),
  state          varchar(16)  NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'active', 'retired', 'revoked')),
  not_before_epoch_micros bigint NOT NULL
    CHECK (not_before_epoch_micros > 0),
  not_after_epoch_micros  bigint NOT NULL
    CHECK (not_after_epoch_micros > not_before_epoch_micros),
  created_at_epoch_micros bigint NOT NULL
    CHECK (created_at_epoch_micros > 0),
  created_at     timestamptz  NOT NULL DEFAULT clock_timestamp()
);

-- Only one key may be active at a time
CREATE UNIQUE INDEX IF NOT EXISTS
  meri_phase4_signing_key_registry_active_idx
  ON meri_phase4_signing_key_registry (state)
  WHERE state = 'active';

ALTER TABLE meri_phase4_signing_key_registry OWNER TO meri_phase4_signing_key_admin;
ALTER TABLE meri_phase4_signing_key_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE meri_phase4_signing_key_registry FORCE ROW LEVEL SECURITY;

-- Key admin can manage all keys
CREATE POLICY meri_phase4_key_admin_all ON meri_phase4_signing_key_registry
  FOR ALL TO meri_phase4_signing_key_admin USING (true) WITH CHECK (true);

-- Verifier can read active/retired keys (needs public key for verification)
CREATE POLICY meri_phase4_verifier_read_keys ON meri_phase4_signing_key_registry
  FOR SELECT TO meri_phase4_broker_signer_owner
  USING (state IN ('active', 'retired'));

-- Signer can read active keys (to confirm which key to use)
CREATE POLICY meri_phase4_signer_read_active_keys ON meri_phase4_signing_key_registry
  FOR SELECT TO meri_phase4_broker_signer
  USING (state = 'active');

-- ── Key lifecycle events ──

CREATE TABLE IF NOT EXISTS meri_phase4_signing_key_lifecycle_events (
  event_id       uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id         varchar(128) NOT NULL
    REFERENCES meri_phase4_signing_key_registry(key_id),
  kind           varchar(16)  NOT NULL
    CHECK (kind IN ('activated', 'retired', 'revoked')),
  reason         text         NOT NULL
    CHECK (char_length(reason) > 0 AND char_length(reason) <= 500),
  occurred_at_epoch_micros bigint NOT NULL
    CHECK (occurred_at_epoch_micros > 0),
  created_at     timestamptz  NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS
  meri_phase4_key_lifecycle_events_key_idx
  ON meri_phase4_signing_key_lifecycle_events (key_id, occurred_at_epoch_micros);

ALTER TABLE meri_phase4_signing_key_lifecycle_events OWNER TO meri_phase4_signing_key_admin;
ALTER TABLE meri_phase4_signing_key_lifecycle_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE meri_phase4_signing_key_lifecycle_events FORCE ROW LEVEL SECURITY;

CREATE POLICY meri_phase4_key_admin_events ON meri_phase4_signing_key_lifecycle_events
  FOR ALL TO meri_phase4_signing_key_admin USING (true) WITH CHECK (true);

CREATE POLICY meri_phase4_verifier_read_events ON meri_phase4_signing_key_lifecycle_events
  FOR SELECT TO meri_phase4_broker_signer_owner USING (true);

-- ── Signing requests ──

CREATE TABLE IF NOT EXISTS meri_phase4_signing_requests (
  request_id     uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  claims_sha256  char(64)     NOT NULL
    CHECK (claims_sha256 ~ '^[0-9a-f]{64}$'),
  qualification_sha256 char(64) NOT NULL
    CHECK (qualification_sha256 ~ '^[0-9a-f]{64}$'),
  key_id         varchar(128) NOT NULL
    REFERENCES meri_phase4_signing_key_registry(key_id),
  state          varchar(16)  NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'signed', 'expired', 'cancelled')),
  requested_at_epoch_micros bigint NOT NULL
    CHECK (requested_at_epoch_micros > 0),
  sign_by_epoch_micros bigint NOT NULL
    CHECK (sign_by_epoch_micros > requested_at_epoch_micros),
  created_at     timestamptz  NOT NULL DEFAULT clock_timestamp()
);

-- For signer: find pending requests to sign, with SKIP LOCKED
CREATE INDEX IF NOT EXISTS
  meri_phase4_signing_requests_pending_idx
  ON meri_phase4_signing_requests (state, sign_by_epoch_micros)
  WHERE state = 'pending';

-- For deduplication: same claims + key = same request
CREATE UNIQUE INDEX IF NOT EXISTS
  meri_phase4_signing_requests_claims_key_idx
  ON meri_phase4_signing_requests (claims_sha256, key_id)
  WHERE state IN ('pending', 'signed');

ALTER TABLE meri_phase4_signing_requests OWNER TO meri_phase4_broker_signer_owner;
ALTER TABLE meri_phase4_signing_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE meri_phase4_signing_requests FORCE ROW LEVEL SECURITY;

-- Verifier (owner) can manage requests
CREATE POLICY meri_phase4_verifier_manage_requests ON meri_phase4_signing_requests
  FOR ALL TO meri_phase4_broker_signer_owner USING (true) WITH CHECK (true);

-- Signer can read pending requests and update state to 'signed'
CREATE POLICY meri_phase4_signer_read_requests ON meri_phase4_signing_requests
  FOR SELECT TO meri_phase4_broker_signer USING (state = 'pending');

-- Effect operator can insert new signing requests
CREATE POLICY meri_phase4_operator_insert_requests ON meri_phase4_signing_requests
  FOR INSERT TO meri_phase4_broker_effect_operator WITH CHECK (true);

CREATE POLICY meri_phase4_operator_read_requests ON meri_phase4_signing_requests
  FOR SELECT TO meri_phase4_broker_effect_operator USING (true);

-- ── Signature submissions ──

CREATE TABLE IF NOT EXISTS meri_phase4_signature_submissions (
  submission_id  uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id     uuid         NOT NULL
    REFERENCES meri_phase4_signing_requests(request_id),
  key_id         varchar(128) NOT NULL
    REFERENCES meri_phase4_signing_key_registry(key_id),
  signature      varchar(86)  NOT NULL
    CHECK (signature ~ '^[A-Za-z0-9_-]{85}[AQgw]$'),
  signed_at_epoch_micros bigint NOT NULL
    CHECK (signed_at_epoch_micros > 0),
  created_at     timestamptz  NOT NULL DEFAULT clock_timestamp()
);

-- One submission per request
CREATE UNIQUE INDEX IF NOT EXISTS
  meri_phase4_signature_submissions_request_idx
  ON meri_phase4_signature_submissions (request_id);

ALTER TABLE meri_phase4_signature_submissions OWNER TO meri_phase4_broker_signer;
ALTER TABLE meri_phase4_signature_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE meri_phase4_signature_submissions FORCE ROW LEVEL SECURITY;

-- Signer can insert submissions
CREATE POLICY meri_phase4_signer_insert_submissions ON meri_phase4_signature_submissions
  FOR INSERT TO meri_phase4_broker_signer WITH CHECK (true);

CREATE POLICY meri_phase4_signer_read_submissions ON meri_phase4_signature_submissions
  FOR SELECT TO meri_phase4_broker_signer USING (true);

-- Verifier can read submissions for verification
CREATE POLICY meri_phase4_verifier_read_submissions ON meri_phase4_signature_submissions
  FOR SELECT TO meri_phase4_broker_signer_owner USING (true);

-- ── Attestations (with attestation_id PK, replacing claims_sha256 PK) ──

CREATE TABLE IF NOT EXISTS meri_phase4_signing_attestations (
  attestation_id uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  claims_sha256  char(64)     NOT NULL
    CHECK (claims_sha256 ~ '^[0-9a-f]{64}$'),
  signer_key_id  varchar(128) NOT NULL
    REFERENCES meri_phase4_signing_key_registry(key_id),
  signature      varchar(86)  NOT NULL
    CHECK (signature ~ '^[A-Za-z0-9_-]{85}[AQgw]$'),
  verification_method varchar(32) NOT NULL DEFAULT 'Ed25519-SPKI-SHA256'
    CHECK (verification_method = 'Ed25519-SPKI-SHA256'),
  qualification_sha256 char(64) NOT NULL
    CHECK (qualification_sha256 ~ '^[0-9a-f]{64}$'),
  verified_at_epoch_micros bigint NOT NULL
    CHECK (verified_at_epoch_micros > 0),
  expires_at_epoch_micros  bigint NOT NULL
    CHECK (expires_at_epoch_micros > verified_at_epoch_micros),
  created_at     timestamptz  NOT NULL DEFAULT clock_timestamp()
);

-- Deterministic latest-unexpired selection by claims digest
CREATE INDEX IF NOT EXISTS
  meri_phase4_signing_attestations_claims_idx
  ON meri_phase4_signing_attestations (claims_sha256, expires_at_epoch_micros DESC)
  WHERE expires_at_epoch_micros > 0;

-- Exact attestation lookup for refresh
CREATE UNIQUE INDEX IF NOT EXISTS
  meri_phase4_signing_attestations_exact_idx
  ON meri_phase4_signing_attestations (
    claims_sha256, signer_key_id, signature,
    qualification_sha256, verified_at_epoch_micros
  );

ALTER TABLE meri_phase4_signing_attestations OWNER TO meri_phase4_broker_signer_owner;
ALTER TABLE meri_phase4_signing_attestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE meri_phase4_signing_attestations FORCE ROW LEVEL SECURITY;

-- Verifier can manage attestations
CREATE POLICY meri_phase4_verifier_manage_attestations ON meri_phase4_signing_attestations
  FOR ALL TO meri_phase4_broker_signer_owner USING (true) WITH CHECK (true);

-- Effect operator can read attestations (to check signing status)
CREATE POLICY meri_phase4_operator_read_attestations ON meri_phase4_signing_attestations
  FOR SELECT TO meri_phase4_broker_effect_operator USING (true);

-- ── No unauthorized access ──
-- capiro_app, meri_phase4_route_operator, and meri_phase4_recovery_operator
-- get NO DML on any signing table. This is enforced by RLS + ownership.
