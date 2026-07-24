-- Phase 2 (Stage A1): dependency edges between plan steps. A node lists the
-- sibling node ids that must complete before it — the substrate the shared
-- strategy verifier needs to check ordering (gate/decision precedence,
-- submission-before-markup, dependency slippage). Intra-strategy references
-- only, validated in application code (no cross-table FK, per the sp_* engine
-- rule). Additive + defaulted to an empty array; no backfill required.
ALTER TABLE "sp_node" ADD COLUMN "depends_on_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[];

-- Rollback (forward-only migrate; documented per plan):
--   ALTER TABLE "sp_node" DROP COLUMN "depends_on_ids";
