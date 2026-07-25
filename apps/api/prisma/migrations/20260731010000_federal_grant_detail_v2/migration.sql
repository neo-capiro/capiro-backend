-- District Nexus + Grants, Phase 1 / Workstream C.
--
-- federal_grant holds Grants.gov OPPORTUNITIES (NOFOs) — not awarded money.
-- It is a global table (no tenant_id, no RLS), same as before; this migration
-- is purely additive and every column is nullable, so it is safe to apply
-- ahead of the code that writes them.
--
-- Ordering note: this must sort AFTER 20260730010000_district_nexus_grants_v2
-- (which is itself after 20260727010000_legislative_district, whose table it
-- ALTERs). The repo uses synthetic sequential YYYYMMDD010000 names rather than
-- wall-clock timestamps — do not "correct" these to the authoring date, it
-- would reorder them ahead of their dependencies.

-- Detail-only fields. search2 returns just 10 fields (id, number, title,
-- agencyCode, agency, openDate, closeDate, oppStatus, docType, cfdaList —
-- verified live 2026-07-24); everything below requires the fetchOpportunity
-- call and is written exclusively by enrich-grant-details.ts.
ALTER TABLE "federal_grant"
  ADD COLUMN IF NOT EXISTS "eligibility_text"   TEXT,
  ADD COLUMN IF NOT EXISTS "cost_sharing"       BOOLEAN,
  ADD COLUMN IF NOT EXISTS "doc_type"           TEXT,
  ADD COLUMN IF NOT EXISTS "revision"           INTEGER,
  ADD COLUMN IF NOT EXISTS "response_date_desc" TEXT,
  ADD COLUMN IF NOT EXISTS "amendment_count"    INTEGER,
  ADD COLUMN IF NOT EXISTS "last_updated_at"    TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "raw"                JSONB,
  ADD COLUMN IF NOT EXISTS "detail_synced_at"   TIMESTAMPTZ(6);

-- 'synopsis' vs 'forecast' is a hard semantic split (a forecast has no real
-- response date and must never be presented as an open solicitation), so it
-- is filtered on constantly.
CREATE INDEX IF NOT EXISTS "federal_grant_doc_type_idx"
  ON "federal_grant" ("doc_type");

-- Candidate scan for the detail-enrichment pass: unenriched first, then
-- stalest-first. Nulls sort last on ASC, so the partial-free plain btree is
-- enough for `ORDER BY detail_synced_at ASC NULLS FIRST`.
CREATE INDEX IF NOT EXISTS "federal_grant_detail_synced_at_idx"
  ON "federal_grant" ("detail_synced_at");
