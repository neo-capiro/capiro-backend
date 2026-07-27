-- LegiWatch Gate E phase f (§4.10) — turn a dismissal into a measurable
-- per-topic signal instead of a per-bill exclusion only.
--
-- ADDITIVE ONLY: two nullable/defaulted columns on an existing table. No
-- DROP, no type change, no NOT NULL without a DEFAULT. A retry
-- (IF NOT EXISTS) is a no-op. Every existing row gets reason=NULL,
-- matched_tags='{}' — feedbackSignal's aggregation is forward-only by
-- design (option (a) of the plan's §6 open decision 3), so historical rows
-- contributing nothing is the INTENDED behavior, not a migration gap.

ALTER TABLE "intel_feedback"
  ADD COLUMN IF NOT EXISTS "reason" TEXT,
  ADD COLUMN IF NOT EXISTS "matched_tags" TEXT[] NOT NULL DEFAULT '{}';
