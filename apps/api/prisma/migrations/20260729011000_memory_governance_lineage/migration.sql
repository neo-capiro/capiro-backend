-- Additive follow-up to 20260729010000_memory_governance_context_v2.
-- Kept separate so candidate lineage is explicit without rewriting legacy FKs.
-- NOT executed by this branch/task.

ALTER TABLE memory_candidate
  ADD COLUMN IF NOT EXISTS duplicate_memory_item_id uuid,
  ADD COLUMN IF NOT EXISTS contradicts_memory_item_id uuid,
  ADD COLUMN IF NOT EXISTS committed_memory_item_id uuid;

CREATE INDEX IF NOT EXISTS memory_candidate_duplicate_item_idx
  ON memory_candidate (tenant_id, duplicate_memory_item_id)
  WHERE duplicate_memory_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS memory_candidate_contradicts_item_idx
  ON memory_candidate (tenant_id, contradicts_memory_item_id)
  WHERE contradicts_memory_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS memory_candidate_committed_item_idx
  ON memory_candidate (tenant_id, committed_memory_item_id)
  WHERE committed_memory_item_id IS NOT NULL;

DO $$ BEGIN
  ALTER TABLE memory_candidate
    ADD CONSTRAINT memory_candidate_duplicate_item_fk
    FOREIGN KEY (duplicate_memory_item_id) REFERENCES memory_items(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE memory_candidate
    ADD CONSTRAINT memory_candidate_contradicts_item_fk
    FOREIGN KEY (contradicts_memory_item_id) REFERENCES memory_items(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE memory_candidate
    ADD CONSTRAINT memory_candidate_committed_item_fk
    FOREIGN KEY (committed_memory_item_id) REFERENCES memory_items(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE memory_cleanup_outbox
  DROP CONSTRAINT IF EXISTS memory_cleanup_operation_check;
ALTER TABLE memory_cleanup_outbox
  ADD CONSTRAINT memory_cleanup_operation_check CHECK (
    operation IN (
      'index_memory_item',
      'revoke_projections',
      'supersede_projections',
      'expire_projections',
      'purge_projections'
    )
  );
