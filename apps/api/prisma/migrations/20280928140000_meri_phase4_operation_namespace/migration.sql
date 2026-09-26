-- Phase 4 item 5: Stable per-tool operation identity
--
-- Adds an API-minted operation namespace UUID to the dispatch intent table.
-- The namespace is generated (gen_random_uuid()) during the claim transition
-- and persisted alongside the claimed state. The worker never submits this
-- value; it is API-owned. Existing rows receive NULL (they were claimed
-- before this column existed). New claims always populate this column.
--
-- The final per-tool operation UUID is derived deterministically in
-- application code from (namespace, dispatch identity, tool, slot) using
-- UUID v5 (RFC 4122 §4.3). PostgreSQL stores only the namespace; the
-- derivation is a pure function of the namespace and call metadata.

ALTER TABLE meri_agent_dispatch_intents
  ADD COLUMN operation_namespace uuid;

-- A partial index covers only claimed rows that have a namespace,
-- supporting efficient lookup of the namespace for a claimed dispatch.
-- Prepared/absent/tombstoned rows have NULL namespace and are excluded.
CREATE INDEX IF NOT EXISTS
  meri_agent_dispatch_intents_claimed_namespace_idx
  ON meri_agent_dispatch_intents (tenant_id, run_id)
  WHERE state = 'claimed' AND operation_namespace IS NOT NULL;
