-- Persist exact export bytes alongside the immutable facts. A later renderer
-- release must not change a historical preview or approved report's links.
-- Earlier qualification-only rows have no retained bytes; callers fail closed
-- instead of claiming a newly rendered document is the historical artifact.
ALTER TABLE intel_legiwatch_report_run
  ADD COLUMN rendered JSONB NOT NULL DEFAULT '{}'::jsonb;
