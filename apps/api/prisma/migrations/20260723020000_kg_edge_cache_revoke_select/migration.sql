-- Track B hardening — close the raw-read belt on kg_edge_cache.
--
-- M1 (20260722010000) deliberately issued NO `GRANT SELECT` on the MV: the
-- design is that kg_edge_cache is readable ONLY by the SECURITY DEFINER
-- traversal/count functions (kg_walk_bounded / kg_neighbors_scoped /
-- kg_edge_cache_count), which read it as owner capiro_master and re-apply the
-- mandatory (tenant_id, denied_client_ids[]) filters at every hop.
--
-- But a dev ECS probe found a plain `SET ROLE capiro_app; SELECT count(*) FROM
-- kg_edge_cache` returns all 578k rows — because capiro_master carries an
-- ALTER DEFAULT PRIVILEGES that auto-grants capiro_app on every relation it
-- creates, silently re-granting the SELECT the migration withheld. That
-- reopens an un-tenanted, un-walled raw-read surface. It is defense-in-depth
-- only (no in-repo code reads the MV directly — asserted by
-- memory-wall-fail-closed.spec.ts), but PROD has no RLS backstop, so the
-- in-function WHERE predicates are the WHOLE enforcement surface there and this
-- raw path must not exist.
--
-- Revoking capiro_app's access does NOT affect the functions (they run with
-- definer rights as capiro_master) nor the refresh job (kg_edge_cache_count()
-- is a definer scalar) — it only removes the direct raw-read path. REFRESH
-- MATERIALIZED VIEW does not recreate the object, so the default privilege will
-- not silently re-grant it; only a DROP+CREATE (the paired revert) would.
REVOKE ALL ON kg_edge_cache FROM capiro_app;
REVOKE ALL ON kg_edge_cache FROM PUBLIC;

-- ROLLBACK (paired revert migration, ECS-applied):
--   GRANT SELECT ON kg_edge_cache TO capiro_app;   -- restores the auto-grant state
