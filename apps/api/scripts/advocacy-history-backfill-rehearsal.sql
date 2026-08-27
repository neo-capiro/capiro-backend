\set ON_ERROR_STOP on

BEGIN;

CREATE TEMP TABLE cursor_rehearsal (
  tenant_id uuid NOT NULL,
  client_id uuid NOT NULL,
  source text NOT NULL,
  watermark_jsonb jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (tenant_id, client_id, source)
);

INSERT INTO cursor_rehearsal VALUES (
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000011',
  'advocacy_history',
  '{"lastLdaPostedAt":"2020-01-01T00:00:00.000Z"}'
);

INSERT INTO cursor_rehearsal VALUES (
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000011',
  'advocacy_history',
  '{"backfill":{"status":"backfill_running","sources":{"lda":{"status":"in_progress","checkpoint":{"scanAt":"2020-01-02T00:00:00.000Z","key":"b","activityIndex":0},"examined":2,"candidates":1}}}}'
)
ON CONFLICT (tenant_id, client_id, source) DO UPDATE
SET watermark_jsonb = cursor_rehearsal.watermark_jsonb || EXCLUDED.watermark_jsonb;

DO $$
DECLARE value jsonb;
BEGIN
  SELECT watermark_jsonb INTO value FROM cursor_rehearsal;
  IF value->>'lastLdaPostedAt' <> '2020-01-01T00:00:00.000Z' THEN
    RAISE EXCEPTION 'merge-on-write erased the incremental watermark';
  END IF;
  IF value#>>'{backfill,sources,lda,checkpoint,key}' <> 'b' THEN
    RAISE EXCEPTION 'backfill checkpoint was not durably merged';
  END IF;
END $$;

CREATE TEMP TABLE source_rows (
  scan_at timestamptz NOT NULL,
  source_key text NOT NULL,
  UNIQUE (scan_at, source_key)
);
INSERT INTO source_rows VALUES
  ('2020-01-01T00:00:00Z', 'a'),
  ('2020-01-01T00:00:00Z', 'b'),
  ('2020-01-01T00:00:00Z', 'c'),
  ('2020-01-02T00:00:00Z', 'd');

DO $$
DECLARE keys text[];
BEGIN
  SELECT array_agg(source_key ORDER BY scan_at, source_key) INTO keys
    FROM source_rows
   WHERE scan_at > '2020-01-01T00:00:00Z'
      OR (scan_at = '2020-01-01T00:00:00Z' AND source_key > 'b');
  IF keys <> ARRAY['c','d'] THEN
    RAISE EXCEPTION 'same-timestamp keyset resume skipped or repeated rows: %', keys;
  END IF;
END $$;

CREATE TEMP TABLE finding_rehearsal (
  run_id uuid NOT NULL,
  content_hash text NOT NULL,
  status text NOT NULL,
  UNIQUE (run_id, content_hash)
);
INSERT INTO finding_rehearsal VALUES
  ('00000000-0000-0000-0000-000000000101', 'accepted-hash', 'accepted'),
  ('00000000-0000-0000-0000-000000000101', 'rejected-hash', 'rejected');
INSERT INTO finding_rehearsal VALUES
  ('00000000-0000-0000-0000-000000000101', 'accepted-hash', 'pending'),
  ('00000000-0000-0000-0000-000000000101', 'rejected-hash', 'pending')
ON CONFLICT (run_id, content_hash) DO NOTHING;

DO $$
BEGIN
  IF (SELECT count(*) FROM finding_rehearsal) <> 2 THEN
    RAISE EXCEPTION 'idempotent finding insert duplicated a terminal finding';
  END IF;
  IF EXISTS (SELECT 1 FROM finding_rehearsal WHERE status = 'pending') THEN
    RAISE EXCEPTION 'accepted/rejected finding resurrected as pending';
  END IF;
END $$;

ROLLBACK;
SELECT 'ADVOCACY_BACKFILL_REHEARSAL_OK' AS result;
