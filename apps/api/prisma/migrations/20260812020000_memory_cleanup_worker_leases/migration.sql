-- MeriV2 closeout Phase 5 — scheduled governed-memory projection worker.
-- Additive only. This migration is committed but is NOT executed by this task.
--
-- A worker claim must survive process/container death without stranding the job in
-- `running` forever. Leases make stale claims reclaimable; dead_letter is terminal
-- evidence after the bounded attempt ceiling is exhausted.

ALTER TABLE memory_cleanup_outbox
  ADD COLUMN IF NOT EXISTS lease_owner varchar(80),
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS dead_lettered_at timestamptz;

ALTER TABLE memory_cleanup_outbox
  DROP CONSTRAINT IF EXISTS memory_cleanup_status_check;
ALTER TABLE memory_cleanup_outbox
  ADD CONSTRAINT memory_cleanup_status_check CHECK (
    status IN ('pending','running','completed','failed','dead_letter')
  );

ALTER TABLE memory_cleanup_outbox
  DROP CONSTRAINT IF EXISTS memory_cleanup_lease_state_check;
ALTER TABLE memory_cleanup_outbox
  ADD CONSTRAINT memory_cleanup_lease_state_check CHECK (
    (status = 'running' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR
    (status <> 'running' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  );

CREATE INDEX IF NOT EXISTS memory_cleanup_outbox_worker_due_idx
  ON memory_cleanup_outbox (status, next_attempt_at, lease_expires_at, created_at)
  WHERE status IN ('pending','failed','running');

CREATE INDEX IF NOT EXISTS memory_cleanup_outbox_dead_letter_idx
  ON memory_cleanup_outbox (tenant_id, dead_lettered_at DESC)
  WHERE status = 'dead_letter';

COMMENT ON COLUMN memory_cleanup_outbox.lease_owner IS
  'Opaque worker claim token. Present only while status=running.';
COMMENT ON COLUMN memory_cleanup_outbox.lease_expires_at IS
  'Expired running claims are eligible for atomic reclaim by another worker.';
COMMENT ON COLUMN memory_cleanup_outbox.dead_lettered_at IS
  'Terminal timestamp after the bounded retry ceiling is exhausted.';
