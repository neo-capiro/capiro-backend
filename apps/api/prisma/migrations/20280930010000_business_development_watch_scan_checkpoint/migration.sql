-- Permit durable, QUIET initial scan progress without claiming a completed
-- baseline. The prior shape constraint required any baseline_state JSON to
-- have baselined_at, which prevented every multi-page first scan from
-- committing. No source, ingestion, table or column is added or removed.
--
-- Preserve every formerly allowed completed-baseline shape for rollback
-- compatibility. The only new allowed shape is an explicitly uninitialized
-- version-1 initial scan with object-shaped staged and accepted records.
-- Application validation owns the stricter checkpoint/record contract.
ALTER TABLE "business_development_watch_source_states"
  DROP CONSTRAINT "business_development_watch_source_states_baseline_shape_check",
  ADD CONSTRAINT "business_development_watch_source_states_baseline_shape_check"
  CHECK (
    ("baselined_at" IS NULL AND "baseline_state" IS NULL)
    OR
    ("baselined_at" IS NOT NULL AND "baseline_state" IS NOT NULL)
    OR
    (
      "baselined_at" IS NULL
      AND COALESCE(
        jsonb_typeof("baseline_state") = 'object'
        AND "baseline_state" @> '{"initialized":false,"scan":{"version":1,"phase":"initial"}}'::jsonb
        AND jsonb_typeof("baseline_state" -> 'records') = 'object'
        AND jsonb_typeof("baseline_state" -> 'scan' -> 'stagedRecords') = 'object',
        false
      )
    )
  );
