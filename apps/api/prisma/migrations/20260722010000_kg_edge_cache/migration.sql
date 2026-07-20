-- Track B M1 — materialized kg_edge_cache (fixes RC1: the non-materialized
-- 22-branch UNION re-evaluated on every traversal hop). Additive; creates only
-- new objects (the old kg_* views + kg_walk are untouched). Populated OUT OF
-- BAND (WITH NO DATA) so the migration txn is instant and never re-litigates the
-- pool-starvation history. Ships DARK: nothing reads this until
-- KG_TRAVERSAL_SOURCE='cache'.
--
-- Wall attribution: canonical (public) edges are never client-attributable ⇒
-- wall_client_ids='{}'. Each tenant-overlay branch stamps ARRAY[client_id] so
-- the bounded traversal can exclude a walled client's edges. The 6 overlay
-- branches emit DISTINCT edge_types, so no (src,dst,edge_type,tenant) collision
-- across branches occurs ⇒ no dedup needed and no wall-merge leak (a v2 can add
-- CONCURRENTLY + a unique key if profiling ever wants it).

CREATE MATERIALIZED VIEW IF NOT EXISTS kg_edge_cache AS
  -- CANONICAL zone (public data; reuse the existing view verbatim, not client-scoped).
  SELECT src_kind, src_id, dst_kind, dst_id, edge_type, confidence, source, observed_at,
         tenant_id, 'canonical'::text AS origin, '{}'::uuid[] AS wall_client_ids
  FROM kg_canonical_edges
  UNION ALL
  -- TENANT OVERLAY, re-derived WITH client attribution for the ethical wall.
  -- (a) client_intel_mapping — src=client
  SELECT 'client'::text, c.id::text,
         (CASE m.source WHEN 'lda' THEN 'lda_client' WHEN 'fec' THEN 'employer'
                        WHEN 'contracting' THEN 'federal_contractor'
                        WHEN 'lobby_intel' THEN 'lobby_intel' ELSE m.source END)::text,
         m.external_id::text, ('client_mapped_to_' || m.source)::text, m.confidence::float,
         (CASE WHEN m.confirmed THEN 'manual_confirmed' ELSE 'auto_matched' END)::text,
         m.updated_at, c.tenant_id, 'tenant'::text, ARRAY[c.id]::uuid[]
  FROM client_intel_mapping m JOIN clients c ON c.id = m.client_id
  UNION ALL
  -- (b) client_has_capability — src=client
  SELECT 'client'::text, client_id::text, 'capability'::text, id::text,
         'client_has_capability'::text, 1.0::float, 'tenant'::text, updated_at, tenant_id,
         'tenant'::text, ARRAY[client_id]::uuid[]
  FROM client_capabilities
  UNION ALL
  -- (c) capability_under_pe — src=capability, attributed to the row's client_id
  SELECT 'capability'::text, id::text, 'program_element'::text, pe_number::text,
         'capability_under_pe'::text, 1.0::float, 'tenant'::text, updated_at, tenant_id,
         'tenant'::text, ARRAY[client_id]::uuid[]
  FROM client_capabilities WHERE pe_number IS NOT NULL
  UNION ALL
  -- (d) meeting_with_client — dst=client
  SELECT 'meeting'::text, id::text, 'client'::text, client_id::text,
         'meeting_with_client'::text, COALESCE(association_score, 1.0)::float,
         COALESCE(association_reason, 'tenant'), updated_at, tenant_id,
         'tenant'::text, ARRAY[client_id]::uuid[]
  FROM meetings WHERE client_id IS NOT NULL
  UNION ALL
  -- (e) mail_thread_with_client — dst=client
  SELECT 'mail_thread'::text, id::text, 'client'::text, client_id::text,
         'mail_thread_with_client'::text, 1.0::float, 'tenant'::text, updated_at, tenant_id,
         'tenant'::text, ARRAY[client_id]::uuid[]
  FROM mail_threads WHERE client_id IS NOT NULL
  UNION ALL
  -- (f) manually_associated_to_client — dst=client
  SELECT entity_type::text, entity_id::text, 'client'::text, client_id::text,
         'manually_associated_to_client'::text, 1.0::float, 'manual_override'::text,
         created_at, tenant_id, 'tenant'::text, ARRAY[client_id]::uuid[]
  FROM client_association_overrides
WITH NO DATA;

-- Traversal-serving indexes (no GIN on wall_client_ids: the predicate is NOT(&&)).
CREATE INDEX IF NOT EXISTS kg_edge_cache_src_idx    ON kg_edge_cache (src_kind, src_id);
CREATE INDEX IF NOT EXISTS kg_edge_cache_dst_idx    ON kg_edge_cache (dst_kind, dst_id);
CREATE INDEX IF NOT EXISTS kg_edge_cache_tenant_idx ON kg_edge_cache (tenant_id);

-- Off-peak refresh (plain REFRESH — brief ACCESS EXCLUSIVE; the nightly window
-- has ~no graph reads). Advisory lock so two overlapping cron fires don't pile
-- up. SECURITY DEFINER so capiro_app can drive it without owning the MV.
CREATE OR REPLACE FUNCTION refresh_kg_edge_cache()
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('refresh_kg_edge_cache')) THEN RETURN; END IF;
  REFRESH MATERIALIZED VIEW kg_edge_cache;
END $$;
GRANT EXECUTE ON FUNCTION refresh_kg_edge_cache() TO capiro_app;
-- No GRANT SELECT ON kg_edge_cache: only SECURITY DEFINER traversal fns read it.

-- ROLLBACK (paired revert migration, ECS-applied):
--   DROP FUNCTION IF EXISTS refresh_kg_edge_cache();
--   DROP MATERIALIZED VIEW IF EXISTS kg_edge_cache;   -- old views/kg_walk untouched
