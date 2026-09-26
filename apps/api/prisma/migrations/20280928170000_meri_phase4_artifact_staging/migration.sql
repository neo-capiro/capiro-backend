-- Phase 4 item 3: Artifact staging and reconciliation tables
--
-- Replaces blind-PUT artifact path with a staged state machine.
-- Tracks upload leases, S3 version reconciliation, and cleanup obligations.

-- ── Artifact staging operations ──

CREATE TABLE IF NOT EXISTS meri_phase4_artifact_staging_operations (
  operation_id   uuid         PRIMARY KEY,
  tenant_id      uuid         NOT NULL,
  run_id         uuid         NOT NULL,
  worker_run_id  varchar(120) NOT NULL,
  dispatch_request_sha256 char(64) NOT NULL
    CHECK (dispatch_request_sha256 ~ '^[0-9a-f]{64}$'),
  scope_id       varchar(200) NOT NULL,
  filename       varchar(255) NOT NULL CHECK (char_length(filename) > 0),
  content_type   varchar(255) NOT NULL CHECK (char_length(content_type) > 0),
  content_length_bytes integer NOT NULL CHECK (content_length_bytes > 0),
  content_sha256 char(64)     NOT NULL
    CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  input_kind     varchar(8)   NOT NULL
    CHECK (input_kind IN ('text', 'base64')),
  stage          varchar(16)  NOT NULL DEFAULT 'validated'
    CHECK (stage IN ('validated', 'lease_claimed', 'uploaded',
                     'reconciled', 'finalized', 'sealed',
                     'quarantined', 'cancelled')),
  s3_key         text,
  fence_token    uuid,
  lease_granted_at_epoch_micros  bigint,
  lease_expires_at_epoch_micros  bigint,
  s3_version_id  varchar(1024),
  actual_content_sha256  char(64)
    CHECK (actual_content_sha256 IS NULL OR actual_content_sha256 ~ '^[0-9a-f]{64}$'),
  actual_content_length_bytes integer,
  digest_match   boolean,
  artifact_id    uuid,
  signed_claims_sha256  char(64)
    CHECK (signed_claims_sha256 IS NULL OR signed_claims_sha256 ~ '^[0-9a-f]{64}$'),
  created_at_epoch_micros  bigint NOT NULL CHECK (created_at_epoch_micros > 0),
  finalized_at_epoch_micros bigint,
  retain_until_epoch_micros bigint NOT NULL CHECK (retain_until_epoch_micros > 0),
  created_at     timestamptz  NOT NULL DEFAULT clock_timestamp()
);

-- Idempotent operation identity
CREATE UNIQUE INDEX IF NOT EXISTS
  meri_phase4_artifact_staging_identity_idx
  ON meri_phase4_artifact_staging_operations (
    tenant_id, operation_id, run_id, worker_run_id,
    dispatch_request_sha256, scope_id
  );

-- Active lease tracking
CREATE INDEX IF NOT EXISTS
  meri_phase4_artifact_staging_lease_idx
  ON meri_phase4_artifact_staging_operations (tenant_id, operation_id)
  WHERE stage IN ('lease_claimed', 'uploaded');

-- Retention cleanup
CREATE INDEX IF NOT EXISTS
  meri_phase4_artifact_staging_retention_idx
  ON meri_phase4_artifact_staging_operations (tenant_id, retain_until_epoch_micros);

ALTER TABLE meri_phase4_artifact_staging_operations OWNER TO meri_phase4_authority_owner;
ALTER TABLE meri_phase4_artifact_staging_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE meri_phase4_artifact_staging_operations FORCE ROW LEVEL SECURITY;

CREATE POLICY meri_phase4_operator_artifact_staging ON meri_phase4_artifact_staging_operations
  FOR ALL TO meri_phase4_broker_effect_operator USING (true) WITH CHECK (true);

CREATE POLICY meri_phase4_authority_artifact_staging ON meri_phase4_artifact_staging_operations
  FOR SELECT TO meri_phase4_authority_owner USING (true);

-- ── Cleanup obligations ──

CREATE TABLE IF NOT EXISTS meri_phase4_artifact_cleanup_obligations (
  obligation_id  uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id   uuid         NOT NULL
    REFERENCES meri_phase4_artifact_staging_operations(operation_id),
  s3_key         text         NOT NULL,
  s3_version_id  varchar(1024) NOT NULL,
  reason         varchar(32)  NOT NULL
    CHECK (reason IN ('digest_mismatch', 'orphaned_upload', 'cancelled')),
  state          varchar(16)  NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'completed', 'failed')),
  created_at_epoch_micros bigint NOT NULL CHECK (created_at_epoch_micros > 0),
  completed_at_epoch_micros bigint,
  created_at     timestamptz  NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS
  meri_phase4_artifact_cleanup_pending_idx
  ON meri_phase4_artifact_cleanup_obligations (state)
  WHERE state = 'pending';

ALTER TABLE meri_phase4_artifact_cleanup_obligations OWNER TO meri_phase4_authority_owner;
ALTER TABLE meri_phase4_artifact_cleanup_obligations ENABLE ROW LEVEL SECURITY;
ALTER TABLE meri_phase4_artifact_cleanup_obligations FORCE ROW LEVEL SECURITY;

CREATE POLICY meri_phase4_operator_cleanup ON meri_phase4_artifact_cleanup_obligations
  FOR ALL TO meri_phase4_broker_effect_operator USING (true) WITH CHECK (true);

CREATE POLICY meri_phase4_authority_cleanup ON meri_phase4_artifact_cleanup_obligations
  FOR SELECT TO meri_phase4_authority_owner USING (true);
