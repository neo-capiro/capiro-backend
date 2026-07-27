-- Gate K (MP-09, c-1) — key the per-topic dismissal signal by stable topic
-- id instead of label, so renaming a watchlist tag no longer severs its
-- accumulated feedbackSignal down-weighting.
--
-- ADDITIVE ONLY: one nullable-by-default column on an existing table. No
-- DROP, no type change, no NOT NULL without a DEFAULT. A retry
-- (IF NOT EXISTS) is a no-op. Every existing row gets matched_topic_ids='{}'
-- — feedbackSignal's aggregation is forward-only by design (matches the
-- existing matched_tags column's own precedent, migration
-- 20260803020000), so historical rows contributing nothing via this new
-- column (they still contribute via matched_tags) is the INTENDED
-- behavior, not a migration gap. Do NOT backfill by matching labels to
-- ids — a rename would mis-attribute a historical dismissal to the wrong
-- topic, which is exactly the failure mode this column exists to prevent
-- going forward.
--
-- Gate K's own Open Decision on folding Gate F's proposed
-- (tenant_id, user_id, state) index into this migration was declined
-- (Neo-confirmed 2026-07-27): that index was not found anywhere in the
-- live schema or migration history, so this migration ships alone rather
-- than guessing at an unverifiable shape from another gate's plan.

ALTER TABLE "intel_feedback"
  ADD COLUMN IF NOT EXISTS "matched_topic_ids" TEXT[] NOT NULL DEFAULT '{}';
