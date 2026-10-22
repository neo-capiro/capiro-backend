-- PROPOSAL ONLY: Fable reviews live schema/data, snapshots, numbering, locking,
-- batching and rollout. Do not execute automatically or from application code.
-- Run after ws04-client-association.sql, before enabling client-scoped consumers.
-- Exact trimmed spelling only: no fuzzy/case-folded name inference. Ambiguous,
-- zero-match, inactive/archived, prospect and source-bound rows remain unchanged.
-- Versions are immutable historical attribution and are deliberately untouched.
WITH unique_matches AS (
  SELECT d.id, d.tenant_id, min(c.id::text)::uuid AS client_id
  FROM ws_draft d
  JOIN clients c ON c.tenant_id = d.tenant_id
    AND btrim(c.name) = btrim(d.client)
    AND c.status::text = 'active'
    AND COALESCE(c.profile_status::text, 'ACTIVE') <> 'ARCHIVED'
  WHERE d.client_id IS NULL
    AND d.prospect_id IS NULL
    AND NULLIF(btrim(d.client), '') IS NOT NULL
    AND jsonb_typeof(d.config) = 'object'
    AND (d.config->>'clientId') IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM ws_source_action s
      WHERE s.tenant_id = d.tenant_id AND s.draft_id = d.id
    )
  GROUP BY d.id, d.tenant_id
  HAVING count(*) = 1
)
UPDATE ws_draft d
SET client_id = m.client_id,
    config = jsonb_set(d.config, '{clientId}', to_jsonb(m.client_id::text), true)
FROM unique_matches m
WHERE d.id = m.id AND d.tenant_id = m.tenant_id AND d.client_id IS NULL;
-- Current membership and client-wall checks still apply at every read/write.
-- No grants, schema drops, historical rewrites or client-wall changes are included.
