-- MeriV2 Phase 13 — proposer withdrawal is distinct from reviewer rejection.
-- Additive lifecycle expansion only. No existing candidate or memory row is rewritten.

-- The original candidate table may carry a generated or explicitly named CHECK.
-- Drop only the legacy-status CHECK that contains the known auto_committed value;
-- the governed_status CHECK does not contain that value and is therefore untouched.
DO $$
DECLARE
  constraint_row record;
BEGIN
  FOR constraint_row IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'memory_candidate'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%status%'
      AND pg_get_constraintdef(oid) ILIKE '%auto_committed%'
  LOOP
    EXECUTE format(
      'ALTER TABLE memory_candidate DROP CONSTRAINT %I',
      constraint_row.conname
    );
  END LOOP;
END $$;

ALTER TABLE memory_candidate
  ADD CONSTRAINT memory_candidate_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'auto_committed', 'withdrawn'));

CREATE INDEX IF NOT EXISTS memory_candidate_proposer_pending_idx
  ON memory_candidate (tenant_id, proposed_by, created_at ASC)
  WHERE status = 'pending';

COMMENT ON CONSTRAINT memory_candidate_status_check ON memory_candidate IS
  'withdrawn is proposer-initiated; rejected is an independent reviewer decision';
