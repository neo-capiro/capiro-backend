-- Stage 1 compatibility only. Keep this allocated Prisma directory name even
-- though its earlier held source proposed a content-free receipt. This version
-- does not erase or rewrite any existing candidate JSONB value.
--
-- The release owner must first read each target's _prisma_migrations ledger and
-- table shape. If 090000 is already applied or failed, stop for a separately
-- reviewed forward/recovery plan; changing an applied migration is unsafe.
-- Original 020000 Git bytes SHA-256:
-- 090b3140156c8cb40630101e6fd3b8bb5135a846a6d79528fa2fc4d523f0c2c5.
-- The second accepted digest below is the same SQL checked out with CRLF only.
-- Neither digest is the edited, content-free PR86 020000 migration.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
-- Keep the catalog checks and ALTER on one stable table shape. The bounded
-- lock is held until COMMIT, including on a guard exception rollback.
LOCK TABLE public."clio_meri_memory_submissions" IN ACCESS EXCLUSIVE MODE;

DO $stage1_guard$
DECLARE
  receipt_oid oid := to_regclass('public.clio_meri_memory_submissions');
  candidate_attnum smallint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public."_prisma_migrations" m
    WHERE m.migration_name = '20281018020000_clio_meri_memory_submissions'
      AND m.checksum IN (
        '090b3140156c8cb40630101e6fd3b8bb5135a846a6d79528fa2fc4d523f0c2c5',
        'd70772020ba2cec0a4a590a62fa45c1922c774b77a0514836fbeb6204d3ecb97'
      )
      AND m.finished_at IS NOT NULL
      AND m.rolled_back_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Stage 1 requires the original applied 020000 receipt migration'
      USING ERRCODE = '55000';
  END IF;

  IF receipt_oid IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class r
    JOIN pg_catalog.pg_namespace n ON n.oid = r.relnamespace
    WHERE r.oid = receipt_oid AND n.nspname = 'public'
      AND r.relkind = 'r'
      AND r.relrowsecurity AND r.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'Stage 1 requires the original RLS-forced receipt table'
      USING ERRCODE = '55000';
  END IF;

  SELECT a.attnum INTO candidate_attnum
  FROM pg_catalog.pg_attribute a
  WHERE a.attrelid = receipt_oid AND a.attname = 'candidate'
    AND a.attnum > 0 AND NOT a.attisdropped
    AND a.atttypid = 'pg_catalog.jsonb'::regtype
    AND a.attnotnull AND NOT a.atthasdef;
  IF candidate_attnum IS NULL OR (
    SELECT count(*) FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = receipt_oid AND a.attnum > 0 AND NOT a.attisdropped
  ) <> 7 OR (
    SELECT count(*)
    FROM (
      VALUES
        ('tenant_id', 'pg_catalog.uuid'::regtype::oid, -1, false),
        ('candidate_id', 'pg_catalog.uuid'::regtype::oid, -1, false),
        ('candidate_sha256', 'pg_catalog.bpchar'::regtype::oid, 68, false),
        ('proposer_user_id', 'pg_catalog.uuid'::regtype::oid, -1, false),
        ('review_id', 'pg_catalog.uuid'::regtype::oid, -1, false),
        ('candidate', 'pg_catalog.jsonb'::regtype::oid, -1, false),
        ('created_at', 'pg_catalog.timestamptz'::regtype::oid, 6, true)
    ) AS expected(name, type_oid, typmod, has_default)
    JOIN pg_catalog.pg_attribute a
      ON a.attrelid = receipt_oid AND a.attname = expected.name
      AND a.attnum > 0 AND NOT a.attisdropped
    LEFT JOIN pg_catalog.pg_attrdef d
      ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.atttypid = expected.type_oid
      AND a.atttypmod = expected.typmod
      AND a.attnotnull
      AND a.attidentity = '' AND a.attgenerated = ''
      AND (d.oid IS NOT NULL) = expected.has_default
      AND (a.attname <> 'created_at'
        OR upper(pg_catalog.pg_get_expr(d.adbin, d.adrelid)) = 'CURRENT_TIMESTAMP')
  ) <> 7 THEN
    RAISE EXCEPTION 'Stage 1 requires the exact original seven receipt columns, types, nullability and defaults'
      USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = receipt_oid
      AND c.conname = 'clio_meri_memory_submissions_candidate_check'
      AND c.contype = 'c'
      AND c.convalidated
      AND c.conkey = ARRAY[candidate_attnum]::smallint[]
      -- pg_get_expr can add outer parentheses, spaces and identifier quotes;
      -- any other deparsed expression fails this exact normalized comparison.
      AND regexp_replace(
        pg_catalog.pg_get_expr(c.conbin, c.conrelid), '[[:space:]()"]', '', 'g'
      ) IN (
        'jsonb_typeofcandidate=''object''::text',
        'jsonb_typeofcandidate=''object'''
      )
  ) THEN
    RAISE EXCEPTION 'Stage 1 requires the original candidate object check'
      USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_proc f ON f.oid = t.tgfoid
    JOIN pg_catalog.pg_namespace n ON n.oid = f.pronamespace
    WHERE t.tgrelid = receipt_oid
      AND t.tgname = 'clio_meri_memory_submission_immutable'
      -- tgtype 19 = row (1) + before (2) + update (16).
      AND NOT t.tgisinternal AND t.tgenabled = 'O' AND t.tgtype = 19
      AND n.nspname = 'public'
      AND f.proname = 'clio_meri_memory_submission_immutable'
      AND pg_catalog.pg_get_function_identity_arguments(f.oid) = ''
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy p
    WHERE p.polrelid = receipt_oid
      AND p.polname = 'clio_meri_memory_submissions_isolation'
      AND p.polcmd = '*'
  ) THEN
    RAISE EXCEPTION 'Stage 1 requires the named enabled trigger and RLS policy footprint'
      USING ERRCODE = '55000';
  END IF;
END
$stage1_guard$;

-- PostgreSQL CHECK accepts NULL; old non-null candidate values are untouched.
-- The current Core writer can then omit candidate while the immutable receipt
-- keeps its ID, digest, proposer and review ID for stable replay.
ALTER TABLE public."clio_meri_memory_submissions"
  ALTER COLUMN "candidate" DROP NOT NULL;

COMMIT;
