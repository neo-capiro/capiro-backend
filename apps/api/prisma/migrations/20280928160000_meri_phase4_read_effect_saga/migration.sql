-- Phase 4 item 2: Budget-consuming read-effect saga tables
--
-- Stores durable read-effect operations with fenced leases, content-free
-- response manifests, and sealed receipts. Query text, excerpts, attachment
-- bytes, and extracted text are never stored.

-- ── Read-effect operations ──

CREATE TABLE IF NOT EXISTS meri_phase4_read_effect_operations (
  operation_id   uuid         PRIMARY KEY,
  tenant_id      uuid         NOT NULL,
  run_id         uuid         NOT NULL,
  worker_run_id  varchar(120) NOT NULL,
  dispatch_request_sha256 char(64) NOT NULL
    CHECK (dispatch_request_sha256 ~ '^[0-9a-f]{64}$'),
  scope_id       varchar(200) NOT NULL,
  tool_name      varchar(32)  NOT NULL
    CHECK (tool_name IN ('meri_memory_search', 'meri_fetch_attachment')),
  request_params_sha256 char(64) NOT NULL
    CHECK (request_params_sha256 ~ '^[0-9a-f]{64}$'),
  stage          varchar(16)  NOT NULL DEFAULT 'prepared'
    CHECK (stage IN ('prepared', 'admitted', 'executing', 'sealing',
                     'sealed', 'cancelled', 'quarantined')),
  fence_token    uuid,
  lease_sha256   char(64)
    CHECK (lease_sha256 IS NULL OR lease_sha256 ~ '^[0-9a-f]{64}$'),
  lease_granted_at_epoch_micros  bigint,
  lease_expires_at_epoch_micros  bigint,
  response_sha256  char(64)
    CHECK (response_sha256 IS NULL OR response_sha256 ~ '^[0-9a-f]{64}$'),
  response_length_bytes  integer,
  has_content    boolean,
  content_status varchar(32),
  result_count   integer,
  manifest_sha256  char(64)
    CHECK (manifest_sha256 IS NULL OR manifest_sha256 ~ '^[0-9a-f]{64}$'),
  signed_claims_sha256  char(64)
    CHECK (signed_claims_sha256 IS NULL OR signed_claims_sha256 ~ '^[0-9a-f]{64}$'),
  cancellation_reason  varchar(32)
    CHECK (cancellation_reason IS NULL OR
           cancellation_reason IN ('timeout', 'stop_requested',
             'lease_expired', 'authority_revoked', 'execution_error')),
  created_at_epoch_micros  bigint NOT NULL CHECK (created_at_epoch_micros > 0),
  sealed_at_epoch_micros   bigint,
  cancelled_at_epoch_micros bigint,
  retain_until_epoch_micros bigint NOT NULL CHECK (retain_until_epoch_micros > 0),
  created_at     timestamptz  NOT NULL DEFAULT clock_timestamp()
);

-- For idempotent replay: same operation + tool = same saga
CREATE UNIQUE INDEX IF NOT EXISTS
  meri_phase4_read_effect_ops_identity_idx
  ON meri_phase4_read_effect_operations (
    tenant_id, operation_id, run_id, worker_run_id,
    dispatch_request_sha256, scope_id, tool_name, request_params_sha256
  );

-- For fenced lease checking
CREATE INDEX IF NOT EXISTS
  meri_phase4_read_effect_ops_lease_idx
  ON meri_phase4_read_effect_operations (tenant_id, operation_id)
  WHERE stage IN ('admitted', 'executing');

-- Retention cleanup
CREATE INDEX IF NOT EXISTS
  meri_phase4_read_effect_ops_retention_idx
  ON meri_phase4_read_effect_operations (tenant_id, retain_until_epoch_micros);

ALTER TABLE meri_phase4_read_effect_operations OWNER TO meri_phase4_authority_owner;
ALTER TABLE meri_phase4_read_effect_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE meri_phase4_read_effect_operations FORCE ROW LEVEL SECURITY;

-- Effect operator can manage read-effect operations
CREATE POLICY meri_phase4_operator_read_effects ON meri_phase4_read_effect_operations
  FOR ALL TO meri_phase4_broker_effect_operator USING (true) WITH CHECK (true);

-- Authority owner can read for recovery
CREATE POLICY meri_phase4_authority_read_effects ON meri_phase4_read_effect_operations
  FOR SELECT TO meri_phase4_authority_owner USING (true);

-- GRANT EXECUTE on future read-effect SECURITY DEFINER functions
-- will be added when the saga functions are implemented.
