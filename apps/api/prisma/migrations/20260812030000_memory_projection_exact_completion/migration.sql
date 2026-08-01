-- MeriV2 closeout Phase 6 — exact, failure-aware projection completion.
-- Additive only. This migration is committed but is NOT executed by this task.
--
-- Every index job carries the exact clio_memory version and canonical projection
-- content hash it owes. A newer version terminates the older job as `superseded`
-- instead of allowing either the fast path or worker to complete the wrong job.

ALTER TABLE memory_cleanup_outbox
  ADD COLUMN IF NOT EXISTS expected_source_version timestamptz,
  ADD COLUMN IF NOT EXISTS expected_content_hash varchar(64),
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz;

ALTER TABLE memory_cleanup_outbox
  DROP CONSTRAINT IF EXISTS memory_cleanup_status_check;
ALTER TABLE memory_cleanup_outbox
  ADD CONSTRAINT memory_cleanup_status_check CHECK (
    status IN ('pending','running','completed','failed','dead_letter','superseded')
  );

ALTER TABLE memory_cleanup_outbox
  DROP CONSTRAINT IF EXISTS memory_cleanup_index_expectation_check;
ALTER TABLE memory_cleanup_outbox
  ADD CONSTRAINT memory_cleanup_index_expectation_check CHECK (
    operation <> 'index_memory_item'
    OR (
      expected_source_version IS NOT NULL
      AND expected_content_hash IS NOT NULL
      AND expected_content_hash ~ '^[0-9a-f]{64}$'
    )
  ) NOT VALID;

-- Existing Phase 5 index rows predate exact expectations. They remain retryable and
-- visible; production rollout validates/quarantines them before this check is validated.
CREATE INDEX IF NOT EXISTS memory_cleanup_outbox_exact_index_job_idx
  ON memory_cleanup_outbox (
    tenant_id, clio_memory_id, operation, expected_source_version, expected_content_hash
  )
  WHERE operation = 'index_memory_item'
    AND status IN ('pending','failed','running');

CREATE INDEX IF NOT EXISTS memory_cleanup_outbox_superseded_idx
  ON memory_cleanup_outbox (tenant_id, superseded_at DESC)
  WHERE status = 'superseded';

COMMENT ON COLUMN memory_cleanup_outbox.expected_source_version IS
  'Exact clio_memory.updated_at captured in the source mutation transaction.';
COMMENT ON COLUMN memory_cleanup_outbox.expected_content_hash IS
  'SHA-256 of the canonical memory_item embedding text expected for this job.';
COMMENT ON COLUMN memory_cleanup_outbox.superseded_at IS
  'Terminal timestamp when a newer source version safely replaced this obligation.';
