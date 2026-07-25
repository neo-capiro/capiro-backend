-- P0-1 (deep-audit finding "Restoring a strategy version can destroy or orphan
-- operational history"): make version restore NON-DESTRUCTIVE.
--
-- Before this migration VersionService.restore did `DELETE FROM sp_node WHERE
-- strategy_id = $1` and re-created the node set from the chosen snapshot. Because
-- sp_node_artifact.node_id is ON DELETE CASCADE, that silently destroyed every
-- Workspace-draft / Outreach-record back-link on any node the snapshot did not
-- contain, and left sp_agent_run rows (which carry node_id inside findings JSON
-- with no FK) pointing at ids that no longer exist.
--
-- The fix is a soft delete: restore now ARCHIVES the nodes the snapshot omits and
-- marks their artifact relationships DETACHED, so nothing operational is deleted.
-- Both additions are additive + nullable, so there is no backfill and existing
-- rows read as "live" / "attached" exactly as before.
--
-- Node ids in a snapshot are stable, so restoring a NEWER version whose snapshot
-- contains an archived node REVIVES it (archived_at back to NULL) and re-attaches
-- its artifacts (detached_at back to NULL).

-- Soft-delete marker + attribution for a node the restore archived.
ALTER TABLE "sp_node" ADD COLUMN "archived_at" TIMESTAMP(3);
ALTER TABLE "sp_node" ADD COLUMN "archived_by_user_id" TEXT;
ALTER TABLE "sp_node" ADD COLUMN "archived_reason" TEXT;

-- The node->artifact relationship becomes HISTORICAL rather than being deleted.
-- The upstream artifact itself (ws_draft / outreach_records, owned by other
-- engines) is never touched by a restore.
ALTER TABLE "sp_node_artifact" ADD COLUMN "detached_at" TIMESTAMP(3);
ALTER TABLE "sp_node_artifact" ADD COLUMN "detached_reason" TEXT;

-- No new index: the existing (tenant_id, strategy_id) index on sp_node already
-- narrows to a single strategy's node set, so the added `archived_at IS NULL`
-- predicate on live reads (and `IS NOT NULL` on the detached surface) is free.
-- Same for sp_node_artifact's (tenant_id, strategy_id).

-- Rollback (forward-only migrate; documented per plan):
--   ALTER TABLE "sp_node_artifact" DROP COLUMN "detached_reason";
--   ALTER TABLE "sp_node_artifact" DROP COLUMN "detached_at";
--   ALTER TABLE "sp_node" DROP COLUMN "archived_reason";
--   ALTER TABLE "sp_node" DROP COLUMN "archived_by_user_id";
--   ALTER TABLE "sp_node" DROP COLUMN "archived_at";
