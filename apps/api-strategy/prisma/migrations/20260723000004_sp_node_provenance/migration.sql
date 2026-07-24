-- Phase 2 (Stage A9): per-node grounding provenance. Records which Client
-- Context Pack sections (and, in Stage E, which ContextFacts) a Meri-authored
-- node was grounded in, so a plan step can be traced to its source and audited.
-- Additive + nullable (manual nodes have no provenance).
ALTER TABLE "sp_node" ADD COLUMN "provenance" JSONB;

-- Rollback (forward-only migrate; documented per plan):
--   ALTER TABLE "sp_node" DROP COLUMN "provenance";
