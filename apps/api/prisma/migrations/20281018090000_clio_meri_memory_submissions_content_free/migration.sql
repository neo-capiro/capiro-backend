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
      AND r.relkind = 'r' AND r.relpersistence = 'p'
      AND NOT r.relispartition
      AND r.relrowsecurity AND r.relforcerowsecurity
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_inherits i
        WHERE i.inhrelid = receipt_oid OR i.inhparent = receipt_oid
      )
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

  -- An additional CHECK can silently preserve NOT NULL semantics after the
  -- ALTER (for example CHECK (candidate IS NOT NULL)). Do not let a named
  -- original constraint hide any extra constraint on this receipt table.
  IF (
    SELECT count(*) FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = receipt_oid
  ) <> 5 OR (
    SELECT count(*)
    FROM (
      VALUES
        ('clio_meri_memory_submissions_pkey', 'p'),
        ('clio_meri_memory_submissions_review_id_key', 'u'),
        ('clio_meri_memory_submissions_tenant_fkey', 'f'),
        ('clio_meri_memory_submissions_sha_check', 'c'),
        ('clio_meri_memory_submissions_candidate_check', 'c')
    ) AS expected(name, kind)
    JOIN pg_catalog.pg_constraint c
      ON c.conrelid = receipt_oid AND c.conname = expected.name
    WHERE c.contype = expected.kind::"char" AND c.convalidated
  ) <> 5 THEN
    RAISE EXCEPTION 'Stage 1 requires only the five original validated receipt constraints'
      USING ERRCODE = '55000';
  END IF;

  -- Constraint names alone do not establish the original replay/tenant keys.
  IF (
    SELECT count(*)
    FROM (
      VALUES
        ('clio_meri_memory_submissions_pkey', 'p', ARRAY['tenant_id', 'candidate_id']),
        ('clio_meri_memory_submissions_review_id_key', 'u', ARRAY['review_id']),
        ('clio_meri_memory_submissions_tenant_fkey', 'f', ARRAY['tenant_id'])
    ) AS expected(name, kind, columns)
    JOIN pg_catalog.pg_constraint c
      ON c.conrelid = receipt_oid AND c.conname = expected.name
    WHERE c.contype = expected.kind::"char" AND c.convalidated
      AND NOT c.condeferrable AND NOT c.condeferred
      AND c.conkey = ARRAY(
        SELECT a.attnum
        FROM unnest(expected.columns) WITH ORDINALITY AS column_name(name, position)
        JOIN pg_catalog.pg_attribute a
          ON a.attrelid = receipt_oid AND a.attname = column_name.name
          AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY column_name.position
      )::smallint[]
      AND (expected.kind <> 'f' OR (
        c.confrelid = 'public.tenants'::regclass
        AND c.confkey = ARRAY[
          (SELECT a.attnum FROM pg_catalog.pg_attribute a
            WHERE a.attrelid = c.confrelid AND a.attname = 'id'
              AND a.attnum > 0 AND NOT a.attisdropped)
        ]::smallint[]
        AND c.confmatchtype = 's' AND c.confupdtype = 'a' AND c.confdeltype = 'c'
      ))
  ) <> 3 THEN
    RAISE EXCEPTION 'Stage 1 requires the original primary, review-unique and tenant foreign keys'
      USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_attribute a
      ON a.attrelid = c.conrelid AND a.attname = 'candidate_sha256'
      AND a.attnum > 0 AND NOT a.attisdropped
    WHERE c.conrelid = receipt_oid
      AND c.conname = 'clio_meri_memory_submissions_sha_check'
      AND c.contype = 'c' AND c.convalidated
      AND c.conkey = ARRAY[a.attnum]::smallint[]
      AND regexp_replace(
        pg_catalog.pg_get_expr(c.conbin, c.conrelid), '[[:space:]()"]', '', 'g'
      ) IN (
        'candidate_sha256::text~''^[0-9a-f]{64}$''::text',
        'candidate_sha256~''^[0-9a-f]{64}$''::text',
        'candidate_sha256::text~''^[0-9a-f]{64}$''',
        'candidate_sha256~''^[0-9a-f]{64}$'''
      )
  ) THEN
    RAISE EXCEPTION 'Stage 1 requires the original SHA check, not another candidate constraint'
      USING ERRCODE = '55000';
  END IF;

  IF (
    SELECT count(*) FROM pg_catalog.pg_trigger t
    WHERE t.tgrelid = receipt_oid AND NOT t.tgisinternal
  ) <> 1 OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_proc f ON f.oid = t.tgfoid
    JOIN pg_catalog.pg_namespace n ON n.oid = f.pronamespace
    WHERE t.tgrelid = receipt_oid
      AND t.tgname = 'clio_meri_memory_submission_immutable'
      -- tgtype 19 = row (1) + before (2) + update (16).
      AND NOT t.tgisinternal AND t.tgenabled = 'O' AND t.tgtype = 19
      AND t.tgqual IS NULL AND t.tgattr = ''::pg_catalog.int2vector
      AND t.tgconstraint = 0
      AND n.nspname = 'public'
      AND f.proname = 'clio_meri_memory_submission_immutable'
      AND pg_catalog.pg_get_function_identity_arguments(f.oid) = ''
      AND f.prorettype = 'pg_catalog.trigger'::regtype
      AND f.pronargs = 0 AND NOT f.prosecdef
      AND f.prolang = (
        SELECT l.oid FROM pg_catalog.pg_language l WHERE l.lanname = 'plpgsql'
      )
      AND regexp_replace(f.prosrc, '[[:space:]]', '', 'g') =
        'BEGINRAISEEXCEPTION''Merimemorysubmissionisimmutable''USINGERRCODE=''23514'';END'
  ) OR (
    SELECT count(*) FROM pg_catalog.pg_policy p WHERE p.polrelid = receipt_oid
  ) <> 1 OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy p
    WHERE p.polrelid = receipt_oid
      AND p.polname = 'clio_meri_memory_submissions_isolation'
      AND p.polcmd = '*' AND p.polpermissive
      AND p.polroles = ARRAY[0]::oid[]
      AND replace(regexp_replace(
        pg_catalog.pg_get_expr(p.polqual, p.polrelid), '[[:space:]()"]', '', 'g'
      ), 'public.', '') = 'rls_bypassORtenant_id=current_tenant_id'
      AND replace(regexp_replace(
        pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '[[:space:]()"]', '', 'g'
      ), 'public.', '') = 'rls_bypassORtenant_id=current_tenant_id'
  ) THEN
    RAISE EXCEPTION 'Stage 1 requires the original immutable trigger and RLS policy semantics'
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
