-- Phase 1 M5.4: `run-intel-workflows` (apps/api) writes a `targeting_brief`
-- intel_action_item per surfaced brief, one per alert (regenerating a brief
-- for the same alert should REPLACE, not accumulate duplicates — the same
-- singleton behavior 'memo'/'report' already have). `kind` is plain TEXT
-- (no enum to alter); only the partial unique index's WHERE clause needs
-- widening so `ON CONFLICT (alert_id, kind) WHERE kind IN (...)` has a
-- matching index to target.
DROP INDEX "intel_action_item_alert_singleton_key";
CREATE UNIQUE INDEX "intel_action_item_alert_singleton_key"
  ON "intel_action_item" ("alert_id", "kind")
  WHERE "kind" IN ('memo', 'report', 'targeting_brief');
