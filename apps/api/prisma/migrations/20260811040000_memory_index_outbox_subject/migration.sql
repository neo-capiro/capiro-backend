-- Durable indexing work for a NEWLY COMMITTED memory (closeout §4, gap B2).
--
-- WHY THIS MIGRATION EXISTS
--
-- MemoryCandidateService.commitToClioMemory used to finish with two
-- fire-and-forget dispatches:
--
--     void this.embedMemory(...)
--     void this.memoryIngest.projectClioMemory(tenantId, memoryId)
--
-- If either lost its race with a container stop, a deploy, or an unhandled
-- rejection, the memory existed in clio_memory but was never projected into
-- memory_items and never embedded. Nothing recorded that the work was owed, so
-- nothing ever retried it: the memory silently never became recallable.
--
-- memory_cleanup_outbox is the durable ledger for exactly this kind of work, but
-- it could not express an INDEX job:
--
--   * memory_item_id was NOT NULL, and at commit time the caller holds only a
--     clio_memory.id -- the memory_items row does not exist yet, because
--     projectClioMemory is what CREATES it. There was no legal subject to
--     enqueue against.
--
-- So the subject column becomes nullable and a CHECK guarantees every job still
-- names at least one subject. Deletion jobs keep naming memory_item_id exactly
-- as before; index jobs name clio_memory_id and the worker resolves (or creates)
-- the memory_items row.
--
-- Additive and reversible: widening a NOT NULL to NULL rejects no existing row,
-- and every already-enqueued job continues to satisfy the new CHECK because it
-- has a memory_item_id.
--
-- NOTE: 'index_memory_item' is ALREADY a legal `operation` value -- the
-- 20260729011000_memory_governance_lineage migration dropped and re-added
-- memory_cleanup_operation_check to include it. No change to that constraint.

ALTER TABLE memory_cleanup_outbox
  ALTER COLUMN memory_item_id DROP NOT NULL;

-- Every job must be about SOMETHING. Without this, dropping the NOT NULL above
-- would allow a row naming neither subject, which the worker could only fail
-- forever.
ALTER TABLE memory_cleanup_outbox
  DROP CONSTRAINT IF EXISTS memory_cleanup_subject_present_check;
ALTER TABLE memory_cleanup_outbox
  ADD CONSTRAINT memory_cleanup_subject_present_check CHECK (
    memory_item_id IS NOT NULL OR clio_memory_id IS NOT NULL
  );

-- The index worker claims by (status, next_attempt_at) like every other job, but
-- it also needs to find a pending index job for one clio_memory row so a repeat
-- save can be recognised as already-owed work. Partial index: index jobs are a
-- small minority of the table and only the unfinished ones are ever looked up.
CREATE INDEX IF NOT EXISTS memory_cleanup_outbox_clio_pending_idx
  ON memory_cleanup_outbox (tenant_id, clio_memory_id)
  WHERE operation = 'index_memory_item' AND status IN ('pending', 'failed');

COMMENT ON COLUMN memory_cleanup_outbox.memory_item_id IS
  'Subject for projection-DELETION jobs. NULL for index_memory_item jobs, which '
  'are enqueued before the memory_items row exists and name clio_memory_id '
  'instead. memory_cleanup_subject_present_check requires one of the two.';
