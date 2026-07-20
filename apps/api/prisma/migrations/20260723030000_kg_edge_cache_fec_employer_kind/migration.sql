-- Track B fix — connect clients to the FEC money-flow subgraph.
--
-- BUG (found by post-deploy sanity probe): the M1 overlay branch (a) maps
-- client_intel_mapping node kinds with `CASE m.source WHEN 'fec' THEN 'employer'`,
-- but the actual data uses source='fec_employer' (there is no 'fec'), so the
-- CASE fell through `ELSE m.source` and emitted a node of kind 'fec_employer'.
-- The canonical FEC money edges use kind 'employer' (src_kind='employer',
-- src_id=contributor_employer). Different kind ⇒ kg_walk_bounded's neighbor match
-- (src_kind=node_kind AND src_id=node_id) never joins them, so NO client can
-- reach employer_contributed_to_committee/_candidate — the money-flow graph was
-- disconnected from every client. Verified: all fec_employer mappings'
-- external_id (the employer NAME, e.g. 'ORACLE CORPORATION') exactly match a
-- fec_contribution.contributor_employer, so harmonizing the kind connects them.
--
-- A materialized view definition cannot be altered in place (no CREATE OR REPLACE
-- MATERIALIZED VIEW), so this DROPs and recreates kg_edge_cache verbatim from M1
-- (20260722010000) with ONE change: the CASE now maps both 'fec' and
-- 'fec_employer' to 'employer'. The SECURITY DEFINER fns (kg_walk_bounded,
-- kg_edge_cache_count, refresh_kg_edge_cache) have string-body/plpgsql
-- definitions with no tracked dependency on the MV, so they survive the DROP.
-- Recreates the 3 indexes and RE-APPLIES the capiro_app/PUBLIC revoke (a fresh
-- MV re-triggers capiro_master's ALTER DEFAULT PRIVILEGES). WITH NO DATA →
-- populate out of band via refresh_kg_edge_cache().

DROP MATERIALIZED VIEW IF EXISTS kg_edge_cache;

CREATE MATERIALIZED VIEW kg_edge_cache AS
  SELECT src_kind, src_id, dst_kind, dst_id, edge_type, confidence, source, observed_at,
         tenant_id, 'canonical'::text AS origin, '{}'::uuid[] AS wall_client_ids,
         NULL::numeric AS agg_weight, NULL::int AS agg_count
  FROM kg_canonical_edges
  WHERE src_kind NOT IN ('fec_contribution', 'lda_filing')
  UNION ALL
  SELECT 'lda_registrant'::text, registrant_id::text, 'lda_client'::text, client_id::text,
         'registrant_lobbies_for_client'::text, 1.0::float, 'senate.gov_lda'::text,
         max(dt_posted), NULL::uuid, 'canonical'::text, '{}'::uuid[],
         NULL::numeric, count(*)::int
  FROM lda_filing WHERE client_id IS NOT NULL AND registrant_id IS NOT NULL
  GROUP BY registrant_id, client_id
  UNION ALL
  SELECT 'lda_client'::text, f.client_id::text, 'lda_issue_code'::text, code,
         'client_lobbies_on_issue'::text, 1.0::float, 'senate.gov_lda'::text,
         max(f.dt_posted), NULL::uuid, 'canonical'::text, '{}'::uuid[],
         NULL::numeric, count(*)::int
  FROM lda_filing f, unnest(f.issue_codes) AS code
  WHERE f.client_id IS NOT NULL AND array_length(f.issue_codes, 1) > 0
  GROUP BY f.client_id, code
  UNION ALL
  SELECT 'lda_registrant'::text, f.registrant_id::text, 'lda_issue_code'::text, code,
         'registrant_lobbies_on_issue'::text, 1.0::float, 'senate.gov_lda'::text,
         max(f.dt_posted), NULL::uuid, 'canonical'::text, '{}'::uuid[],
         NULL::numeric, count(*)::int
  FROM lda_filing f, unnest(f.issue_codes) AS code
  WHERE f.registrant_id IS NOT NULL AND array_length(f.issue_codes, 1) > 0
  GROUP BY f.registrant_id, code
  UNION ALL
  SELECT 'employer'::text, contributor_employer::text, 'fec_committee'::text, committee_id::text,
         'employer_contributed_to_committee'::text, 1.0::float, 'fec.gov'::text,
         max(COALESCE(contribution_date::timestamptz, last_synced_at)), NULL::uuid,
         'canonical'::text, '{}'::uuid[], sum(amount)::numeric, count(*)::int
  FROM fec_contribution
  WHERE contributor_employer IS NOT NULL AND committee_id IS NOT NULL
  GROUP BY contributor_employer, committee_id
  UNION ALL
  SELECT 'employer'::text, contributor_employer::text, 'candidate'::text, candidate_name::text,
         'employer_contributed_to_candidate'::text, 1.0::float, 'fec.gov'::text,
         max(COALESCE(contribution_date::timestamptz, last_synced_at)), NULL::uuid,
         'canonical'::text, '{}'::uuid[], sum(amount)::numeric, count(*)::int
  FROM fec_contribution
  WHERE contributor_employer IS NOT NULL AND candidate_name IS NOT NULL
  GROUP BY contributor_employer, candidate_name
  UNION ALL
  -- TENANT OVERLAY (a) client_intel_mapping — src=client.
  -- FIX: map BOTH 'fec' and 'fec_employer' → 'employer' so the client→employer
  -- bridge lands on the SAME node kind as the FEC money edges above.
  SELECT 'client'::text, c.id::text,
         (CASE m.source WHEN 'lda' THEN 'lda_client'
                        WHEN 'fec' THEN 'employer' WHEN 'fec_employer' THEN 'employer'
                        WHEN 'contracting' THEN 'federal_contractor'
                        WHEN 'lobby_intel' THEN 'lobby_intel' ELSE m.source END)::text,
         m.external_id::text, ('client_mapped_to_' || m.source)::text, m.confidence::float,
         (CASE WHEN m.confirmed THEN 'manual_confirmed' ELSE 'auto_matched' END)::text,
         m.updated_at, c.tenant_id, 'tenant'::text, ARRAY[c.id]::uuid[], NULL::numeric, NULL::int
  FROM client_intel_mapping m JOIN clients c ON c.id = m.client_id
  UNION ALL
  SELECT 'client'::text, client_id::text, 'capability'::text, id::text,
         'client_has_capability'::text, 1.0::float, 'tenant'::text, updated_at, tenant_id,
         'tenant'::text, ARRAY[client_id]::uuid[], NULL::numeric, NULL::int
  FROM client_capabilities
  UNION ALL
  SELECT 'capability'::text, id::text, 'program_element'::text, pe_number::text,
         'capability_under_pe'::text, 1.0::float, 'tenant'::text, updated_at, tenant_id,
         'tenant'::text, ARRAY[client_id]::uuid[], NULL::numeric, NULL::int
  FROM client_capabilities WHERE pe_number IS NOT NULL
  UNION ALL
  SELECT 'meeting'::text, id::text, 'client'::text, client_id::text,
         'meeting_with_client'::text, COALESCE(association_score, 1.0)::float,
         COALESCE(association_reason, 'tenant'), updated_at, tenant_id,
         'tenant'::text, ARRAY[client_id]::uuid[], NULL::numeric, NULL::int
  FROM meetings WHERE client_id IS NOT NULL
  UNION ALL
  SELECT 'mail_thread'::text, id::text, 'client'::text, client_id::text,
         'mail_thread_with_client'::text, 1.0::float, 'tenant'::text, updated_at, tenant_id,
         'tenant'::text, ARRAY[client_id]::uuid[], NULL::numeric, NULL::int
  FROM mail_threads WHERE client_id IS NOT NULL
  UNION ALL
  SELECT entity_type::text, entity_id::text, 'client'::text, client_id::text,
         'manually_associated_to_client'::text, 1.0::float, 'manual_override'::text,
         created_at, tenant_id, 'tenant'::text, ARRAY[client_id]::uuid[], NULL::numeric, NULL::int
  FROM client_association_overrides
WITH NO DATA;

CREATE INDEX IF NOT EXISTS kg_edge_cache_src_idx    ON kg_edge_cache (src_kind, src_id);
CREATE INDEX IF NOT EXISTS kg_edge_cache_dst_idx    ON kg_edge_cache (dst_kind, dst_id);
CREATE INDEX IF NOT EXISTS kg_edge_cache_tenant_idx ON kg_edge_cache (tenant_id);

-- Re-apply the raw-read revoke (20260723020000) — a fresh MV re-triggers the
-- capiro_master default-privilege auto-grant. Definer fns read it as owner.
REVOKE ALL ON kg_edge_cache FROM capiro_app;
REVOKE ALL ON kg_edge_cache FROM PUBLIC;

-- Post-apply: populate out of band — SELECT refresh_kg_edge_cache() (autocommit).
-- ROLLBACK (paired revert): DROP + recreate with the pre-fix CASE (M1 verbatim),
--   re-index, re-revoke; then refresh.
