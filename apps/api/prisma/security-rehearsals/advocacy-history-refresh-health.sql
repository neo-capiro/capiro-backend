\set ON_ERROR_STOP on

BEGIN;

CREATE TEMP TABLE refresh_cursor (
  tenant_id uuid NOT NULL,
  client_id uuid NOT NULL,
  source text NOT NULL,
  watermark_jsonb jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, client_id, source)
);

INSERT INTO refresh_cursor (tenant_id, client_id, source, watermark_jsonb)
VALUES (
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  'advocacy_history',
  '{"backfill":{"status":"backfill_complete","sources":{"lda":{"status":"complete","checkpoint":{"scanAt":"2025-01-01T00:00:00.000Z","key":"filing-1","activityIndex":0}}}},"lastLdaPostedAt":"2025-01-01T00:00:00.000Z"}'
);

INSERT INTO refresh_cursor (tenant_id, client_id, source, watermark_jsonb)
VALUES (
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  'advocacy_history',
  '{"lastLdaPostedAt":"2026-08-26T00:00:00.000Z","lastLdaKey":"filing-2","backfill":{"status":"backfill_complete","sources":{"lda":{"status":"complete","availability":"available","lastAttemptAt":"2026-08-26T00:00:00.000Z","lastSuccessAt":"2026-08-26T00:00:00.000Z","freshness":"fresh","checkpoint":{"scanAt":"2025-01-01T00:00:00.000Z","key":"filing-1","activityIndex":0}}}}}'
)
ON CONFLICT (tenant_id, client_id, source) DO UPDATE
SET watermark_jsonb = refresh_cursor.watermark_jsonb || EXCLUDED.watermark_jsonb;

DO $$
DECLARE state jsonb;
BEGIN
  SELECT watermark_jsonb INTO state FROM refresh_cursor;
  IF state #>> '{backfill,sources,lda,status}' <> 'complete'
    OR state #>> '{backfill,sources,lda,checkpoint,key}' <> 'filing-1'
    OR state ->> 'lastLdaKey' <> 'filing-2'
    OR state #>> '{backfill,sources,lda,lastSuccessAt}' IS NULL THEN
    RAISE EXCEPTION 'cursor rehearsal failed: %', state;
  END IF;
END $$;

CREATE TEMP TABLE refresh_schedule (
  tenant_id uuid NOT NULL,
  client_id uuid NOT NULL,
  enabled boolean NOT NULL,
  cadence_hours integer NOT NULL,
  next_run_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, client_id)
);
INSERT INTO refresh_schedule VALUES (
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  true, 168, now() - interval '1 hour', now()
);

CREATE TEMP TABLE claim_results (pass integer, claimed integer);
WITH due AS (
  SELECT tenant_id, client_id FROM refresh_schedule
  WHERE enabled AND next_run_at <= now()
  FOR UPDATE SKIP LOCKED
), claimed AS (
  UPDATE refresh_schedule schedule
  SET next_run_at = now() + make_interval(hours => schedule.cadence_hours)
  FROM due
  WHERE schedule.tenant_id = due.tenant_id AND schedule.client_id = due.client_id
  RETURNING 1 AS pass, 1 AS claimed
)
INSERT INTO claim_results SELECT pass, claimed FROM claimed;
WITH due AS (
  SELECT tenant_id, client_id FROM refresh_schedule
  WHERE enabled AND next_run_at <= now()
  FOR UPDATE SKIP LOCKED
), claimed AS (
  UPDATE refresh_schedule schedule
  SET next_run_at = now() + make_interval(hours => schedule.cadence_hours)
  FROM due
  WHERE schedule.tenant_id = due.tenant_id AND schedule.client_id = due.client_id
  RETURNING 2 AS pass, 1 AS claimed
)
INSERT INTO claim_results SELECT pass, claimed FROM claimed;

DO $$
BEGIN
  IF (SELECT count(*) FROM claim_results) <> 1 THEN
    RAISE EXCEPTION 'schedule claim was not idempotent';
  END IF;
END $$;

CREATE TEMP TABLE refresh_finding (
  tenant_id uuid NOT NULL,
  client_id uuid NOT NULL,
  target_key text NOT NULL,
  content_hash text NOT NULL,
  status text NOT NULL,
  UNIQUE (tenant_id, client_id, target_key, content_hash)
);
INSERT INTO refresh_finding VALUES (
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  'advocacy:lda:filing-2:0', 'same-source-result', 'rejected'
);
INSERT INTO refresh_finding VALUES (
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  'advocacy:lda:filing-2:0', 'same-source-result', 'pending'
) ON CONFLICT DO NOTHING;

DO $$
BEGIN
  IF (SELECT count(*) FROM refresh_finding) <> 1
    OR (SELECT status FROM refresh_finding) <> 'rejected' THEN
    RAISE EXCEPTION 'multi-refresh idempotency or terminal status preservation failed';
  END IF;
END $$;

SELECT 'advocacy refresh persistence, schedule claim, and idempotency rehearsal passed' AS result;
ROLLBACK;
