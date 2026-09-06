-- District Nexus Release 4 operational hardening: baseline vs. change
-- classification for the deterministic public change ledger.
--
-- Problem: the first-ever population of a whole fiscal year's GSA FRPP
-- publication (an empty prior snapshot) writes one `gsa_property_added` row
-- per federal property observed for the very first time — 291,757 rows for
-- FY2024's initial load, all on a single day, all at severity 'material'
-- (structuralChange:true). The user-facing "recent changes" rail
-- (loadChanges() in priority-intelligence.service.ts) has no way to
-- distinguish this from a genuine later addition, so any district with more
-- than its `take: 20` limit's worth of GSA properties has its recent-changes
-- list entirely dominated by same-day backfill noise, crowding out real
-- CPF/CDS events and any later GSA addition/removal/correction. This is not
-- a one-time FY2024 cleanup problem either: the prior-snapshot comparison in
-- GsaRealPropertyIngestService is scoped per fiscal year, so FY2025's own
-- first load next year would reproduce the identical flood.
--
-- Fix: additive `observation_kind` column, default 'change' (so every
-- existing non-GSA row and every future row from a source with no
-- bulk-backfill risk is unaffected). The ingest-time code
-- (priority-intelligence-gsa-ingest.service.ts) now stamps
-- 'baseline' vs 'change' at the exact point it already knows whether the
-- prior snapshot was empty, so this is not just a one-time historical patch
-- — a future fiscal year's first load gets the same correct treatment.
--
-- No rows are deleted, renamed, or have any other field altered. This
-- migration only adds a column, an index, and backfills the classification
-- for rows that already exist.

ALTER TABLE district_nexus_change
  ADD COLUMN IF NOT EXISTS observation_kind varchar(24) NOT NULL DEFAULT 'change'
    CONSTRAINT district_nexus_change_observation_kind_check
    CHECK (observation_kind IN ('baseline', 'change'));

COMMENT ON COLUMN district_nexus_change.observation_kind IS
  'baseline = first-ever observation of a whole source/year publication (e.g. a fiscal year''s initial GSA FRPP load against an empty prior snapshot); change = everything else. Excluded from the user-facing recent-changes rail when baseline. Rows are never deleted for this reclassification.';

-- Additive: serves the reclassified loadChanges() query
-- (state_code, district_code, observation_kind, observed_at DESC). Kept as
-- its own index rather than modifying district_nexus_change_district_idx, so
-- the original index is never dropped/rebuilt by this migration.
CREATE INDEX IF NOT EXISTS district_nexus_change_district_kind_idx
  ON district_nexus_change (state_code, district_code, observation_kind, observed_at DESC);

-- One-time backfill for the 291,757 rows that already exist: reclassify the
-- known initial-population GSA additions as 'baseline'. Identified precisely
-- via provenance->>'sourceRunId', which every gsa_property_added row already
-- carries (priority-intelligence-gsa-ingest.service.ts) — not a guessed
-- date/count heuristic that could accidentally catch a genuine later
-- addition that happened to land on the same calendar day.
DO $$
DECLARE
  first_run_id text;
BEGIN
  SELECT id::text INTO first_run_id
  FROM gsa_real_property_source_run
  WHERE source_dataset = 'frpp_public_detailed'
    AND dry_run = false
    AND status IN ('success', 'success_with_errors')
  ORDER BY attempted_at ASC
  LIMIT 1;

  IF first_run_id IS NOT NULL THEN
    UPDATE district_nexus_change
    SET observation_kind = 'baseline'
    WHERE change_kind = 'gsa_property_added'
      AND provenance ->> 'sourceRunId' = first_run_id;
  END IF;
END $$;
