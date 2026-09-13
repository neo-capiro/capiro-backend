ALTER TABLE intel_legiwatch_report_subscription ADD COLUMN record_briefs JSONB NOT NULL DEFAULT '[]';
ALTER TABLE intel_legiwatch_report_subscription ADD CONSTRAINT record_briefs_array CHECK(jsonb_typeof(record_briefs)='array' AND jsonb_array_length(record_briefs)<=5);
-- Re-review appends a new audit event. Existing exact-content approvals remain.
DO $$ DECLARE key TEXT; BEGIN
  SELECT conname INTO key FROM pg_constraint WHERE conrelid='intel_hearing_record_brief_review'::regclass AND contype='u';
  IF key IS NOT NULL THEN EXECUTE format('ALTER TABLE intel_hearing_record_brief_review DROP CONSTRAINT %I',key); END IF;
END $$;
