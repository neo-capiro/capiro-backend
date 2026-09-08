-- Tango subaward checkpoint: stable pagination evidence (District Nexus R4 repair).
--
-- The first committed bounded run (2026-09-08, --limit 25) persisted
-- next_page=2 without recording the page size actually used to produce that
-- page numbering (the request limit was min(page_size, remaining) = 25, not
-- the default 100). Resuming with a different page size silently skips
-- records: with Tango offset pagination, page N covers items
-- [(N-1)*L, N*L) for the L used in THAT request, so "page 2" at limit 100
-- starts at item 101 while the first run only consumed items 1-25.
--
-- This migration makes the walk's page size part of the durable checkpoint so
-- resumes are provably continuous, records how that size was established
-- (proven vs operator-asserted for legacy rows), and stores the last
-- provider-reported catalog total so readers can state partial coverage
-- honestly ("N of M ingested so far") without re-probing the provider or
-- hard-coding an observed count.
--
-- All three columns are nullable and back-fill ONLY happens through the
-- sync script itself: the pre-existing legacy row keeps page_size NULL until
-- an operator explicitly recovers it with --resume-page-size (the script
-- fails closed rather than guessing), or the walk naturally restarts. No
-- data migration touches existing values.

ALTER TABLE "tango_subaward_sync_checkpoint"
  ADD COLUMN IF NOT EXISTS "page_size" INTEGER,
  ADD COLUMN IF NOT EXISTS "page_size_source" VARCHAR(16),
  ADD COLUMN IF NOT EXISTS "total_reported" BIGINT;

ALTER TABLE "tango_subaward_sync_checkpoint"
  ADD CONSTRAINT "tango_subaward_sync_checkpoint_page_size_range"
  CHECK ("page_size" IS NULL OR ("page_size" >= 1 AND "page_size" <= 100));

ALTER TABLE "tango_subaward_sync_checkpoint"
  ADD CONSTRAINT "tango_subaward_sync_checkpoint_page_size_source_vocabulary"
  CHECK (
    "page_size_source" IS NULL
    OR "page_size_source" IN ('run_arg', 'checkpoint', 'resume_flag')
  );

ALTER TABLE "tango_subaward_sync_checkpoint"
  ADD CONSTRAINT "tango_subaward_sync_checkpoint_page_size_known_with_source"
  CHECK ("page_size" IS NULL OR "page_size_source" IS NOT NULL);

ALTER TABLE "tango_subaward_sync_checkpoint"
  ADD CONSTRAINT "tango_subaward_sync_checkpoint_total_reported_nonnegative"
  CHECK ("total_reported" IS NULL OR "total_reported" >= 0);
