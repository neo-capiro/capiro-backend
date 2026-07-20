-- Track B M3 — kg_edge_cache_count() + kg view/function comment hygiene.
-- Additive + reversible; no data change.
--
-- 1) kg_edge_cache_count(): the M1 cache deliberately has NO SELECT grant
--    (isolation is enforced entirely inside the SECURITY DEFINER traversal
--    functions), so the refresh job cannot COUNT(*) it as capiro_app. This
--    definer-rights counter is the sanctioned way to report the materialized
--    edge total (run-ledger row size / sudden-drop visibility) without opening
--    a direct read path to the un-walled cache. A bare count leaks nothing:
--    it is a single tenant-blind scalar.
CREATE OR REPLACE FUNCTION kg_edge_cache_count() RETURNS bigint
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT count(*) FROM kg_edge_cache $$;
GRANT EXECUTE ON FUNCTION kg_edge_cache_count() TO capiro_app;

-- 2) Comment hygiene (plan M3): migration 20260525213000 claimed these views
--    "inherit RLS from the underlying tables" — FALSE. They are owned by
--    capiro_master and read with DEFINER rights ⇒ RLS-EXEMPT underneath, in
--    every environment. Correct the catalog comments so the next reader is not
--    misled into treating them as a scoped surface.
COMMENT ON VIEW kg_canonical_edges IS
  'RLS-EXEMPT (master-owned, definer-rights): despite the original migration comment, '
  'RLS is NOT inherited here. Do not query from tenant paths. The sanctioned tenant '
  'surface is kg_walk_bounded(tenant_id, denied_client_ids, ...) over kg_edge_cache '
  '(Track B M2), which re-applies tenant + ethical-wall filters at every hop.';
COMMENT ON VIEW kg_tenant_edges IS
  'RLS-EXEMPT (master-owned, definer-rights): despite the original migration comment, '
  'RLS is NOT inherited here. Do not query from tenant paths. Use kg_walk_bounded.';
COMMENT ON VIEW kg_edges IS
  'RLS-EXEMPT union of kg_canonical_edges + kg_tenant_edges. Do not query from tenant '
  'paths. Use kg_walk_bounded (Track B M2) — mandatory tenant + denied-client params.';
COMMENT ON FUNCTION kg_walk(text, text, int, text[]) IS
  'LEGACY, UNSCOPED, UNBOUNDED traversal over the RLS-exempt kg_* views: no tenant '
  'param, no wall filter, no fanout/row/timeout bound (the 2026 pool-starvation '
  'incident). Retained for reference only — never call from tenant paths; use '
  'kg_walk_bounded instead.';

-- ROLLBACK (paired revert migration, ECS-applied):
--   DROP FUNCTION IF EXISTS kg_edge_cache_count();
--   COMMENT ON VIEW kg_canonical_edges IS NULL; (etc. — comments only)
