-- Knowledge Plane Phase 17: keep coverage/resolution truth on the existing
-- governed ContextPacket row. This is deliberately additive: no new packet
-- table, vector store, graph, or feature-specific context persistence path.
ALTER TABLE "context_packet"
  ADD COLUMN IF NOT EXISTS "retrieval_context_jsonb" JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN "context_packet"."retrieval_context_jsonb" IS
  'Phase 17 resolved subject/entity, coverage, source health/freshness, completeness, and retrieval stop metadata. Evidence refs remain in evidence_jsonb.';
