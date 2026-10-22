-- PF-12: nullable approval metadata for existing meeting debriefs.
-- Release owner applies this forward migration to the authorized database copy
-- after a snapshot, before the backend image that reads these fields.
-- No backfill: historical approval actor/time must remain unknown.

ALTER TABLE "meeting_debriefs"
  ADD COLUMN IF NOT EXISTS "approved_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "approved_by_user_id" UUID;

-- IF NOT EXISTS is retry safety, not permission to accept incompatible columns.
DO $column_shape$
BEGIN
  IF (
    SELECT count(*)
    FROM (
      VALUES
        ('approved_at', 'pg_catalog.timestamptz'::regtype::oid, 6),
        ('approved_by_user_id', 'pg_catalog.uuid'::regtype::oid, -1)
    ) AS expected(name, type_oid, typmod)
    JOIN pg_catalog.pg_attribute a
      ON a.attrelid = 'meeting_debriefs'::regclass
      AND a.attname = expected.name AND a.attnum > 0 AND NOT a.attisdropped
    WHERE a.atttypid = expected.type_oid AND a.atttypmod = expected.typmod
      AND NOT a.attnotnull AND NOT a.atthasdef
      AND a.attidentity = '' AND a.attgenerated = ''
  ) <> 2 THEN
    RAISE EXCEPTION 'PF-12 requires nullable approved_at timestamptz(6) and approved_by_user_id uuid without defaults'
      USING ERRCODE = '55000';
  END IF;
END
$column_shape$;

DO $approval_relationship$
DECLARE
  approval_column smallint;
  user_id_column smallint;
BEGIN
  SELECT attnum INTO approval_column FROM pg_catalog.pg_attribute
    WHERE attrelid = 'meeting_debriefs'::regclass
      AND attname = 'approved_by_user_id' AND attnum > 0 AND NOT attisdropped;
  SELECT attnum INTO user_id_column FROM pg_catalog.pg_attribute
    WHERE attrelid = 'users'::regclass
      AND attname = 'id' AND attnum > 0 AND NOT attisdropped;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'meeting_debriefs'::regclass
      AND conname = 'meeting_debriefs_approved_by_user_id_fkey'
  ) THEN
    ALTER TABLE "meeting_debriefs"
      ADD CONSTRAINT "meeting_debriefs_approved_by_user_id_fkey"
      FOREIGN KEY ("approved_by_user_id") REFERENCES "users"("id")
      ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
  END IF;

  -- A same-name but different relationship must fail closed, not be replaced.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'meeting_debriefs'::regclass
      AND conname = 'meeting_debriefs_approved_by_user_id_fkey'
      AND contype = 'f' AND confrelid = 'users'::regclass
      AND conkey = ARRAY[approval_column]::smallint[]
      AND confkey = ARRAY[user_id_column]::smallint[]
      AND confupdtype = 'c' AND confdeltype = 'n' AND confmatchtype = 's'
      AND NOT condeferrable AND NOT condeferred AND confdelsetcols IS NULL
  ) THEN
    RAISE EXCEPTION 'PF-12 requires the exact meeting-debrief approval user relationship'
      USING ERRCODE = '55000';
  END IF;
END
$approval_relationship$;

-- Validate existing values; an orphan must stop the release, never be erased.
ALTER TABLE "meeting_debriefs"
  VALIDATE CONSTRAINT "meeting_debriefs_approved_by_user_id_fkey";
