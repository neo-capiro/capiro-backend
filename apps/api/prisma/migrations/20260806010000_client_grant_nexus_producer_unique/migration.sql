-- B3 (District Nexus remediation): prevents a concurrent double-run of
-- generate-grant-opportunity-candidates.ts from creating duplicate
-- client_grant_nexus rows for the same (tenant, client, opportunity,
-- relationship) under the SAME evidence source. Five columns, not the four
-- originally proposed: evidence_source_type is included deliberately so a
-- producer row (deterministic_relevance_v1) and a human-entered row (e.g.
-- analyst_manual_entry) for the same pair can still coexist — see
-- generate-grant-opportunity-candidates.spec.ts's "a human-created row for
-- the same pair is never read or touched".
--
-- client_grant_nexus holds a handful of rows in production as of 2026-07-27
-- (the F3 producer's own manual-run output), so a plain (non-CONCURRENTLY)
-- index build is instant and holds no meaningful lock.
CREATE UNIQUE INDEX IF NOT EXISTS "client_grant_nexus_producer_unique_idx"
  ON "client_grant_nexus" ("tenant_id", "client_id", "grant_opportunity_id", "relationship_type", "evidence_source_type");
