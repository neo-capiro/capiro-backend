-- Isolated Funding Opportunities CI dependency only.
--
-- The API migrations intentionally do not own intel_feature_flag, but current
-- Funding Opportunities guards query it. This is the exact table/index/RLS
-- slice from intel-api's live-hearing migration and full-RLS migration; this
-- file does not replay the intel service schema.
--
-- The API identity migration must have created current_tenant_id() and
-- rls_bypass() before this fixture runs. Existing incompatible definitions
-- fail instead of being silently replaced.

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('current_tenant_id()') IS NULL
     OR to_regprocedure('rls_bypass()') IS NULL THEN
    RAISE EXCEPTION 'required API RLS helper functions are missing';
  END IF;

  IF to_regclass('public.intel_feature_flag') IS NULL THEN
    CREATE TABLE "intel_feature_flag" (
      "id" TEXT NOT NULL,
      "feature" TEXT NOT NULL,
      "tenant_id" TEXT NOT NULL,
      "enabled" BOOLEAN NOT NULL DEFAULT true,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "intel_feature_flag_pkey" PRIMARY KEY ("id")
    );
  END IF;

  IF (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'intel_feature_flag') <> 5
     OR EXISTS (
       SELECT 1
       FROM (VALUES
         ('id', 'text', 'NO'),
         ('feature', 'text', 'NO'),
         ('tenant_id', 'text', 'NO'),
         ('enabled', 'boolean', 'NO'),
         ('created_at', 'timestamp without time zone', 'NO')
       ) AS expected(column_name, data_type, is_nullable)
       LEFT JOIN information_schema.columns actual
         ON actual.table_schema = 'public'
        AND actual.table_name = 'intel_feature_flag'
        AND actual.column_name = expected.column_name
       WHERE actual.column_name IS NULL
          OR actual.data_type <> expected.data_type
          OR actual.is_nullable <> expected.is_nullable
     ) THEN
    RAISE EXCEPTION 'intel_feature_flag has an incompatible column shape';
  END IF;

  IF (SELECT column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'intel_feature_flag'
        AND column_name = 'enabled') IS DISTINCT FROM 'true'::text THEN
    RAISE EXCEPTION 'intel_feature_flag.enabled must default to true';
  END IF;

  IF COALESCE((SELECT column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'intel_feature_flag'
        AND column_name = 'created_at'), '') NOT LIKE '%CURRENT_TIMESTAMP%' THEN
    RAISE EXCEPTION 'intel_feature_flag.created_at must default to CURRENT_TIMESTAMP';
  END IF;

  IF (SELECT count(*) FROM pg_constraint
      WHERE conrelid = 'public.intel_feature_flag'::regclass
        AND contype = 'p') <> 1
     OR (SELECT pg_get_constraintdef(oid) FROM pg_constraint
         WHERE conrelid = 'public.intel_feature_flag'::regclass
           AND contype = 'p') <> 'PRIMARY KEY (id)' THEN
    RAISE EXCEPTION 'intel_feature_flag primary key is incompatible';
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS "intel_feature_flag_feature_enabled_idx"
  ON "intel_feature_flag"("feature", "enabled");
CREATE UNIQUE INDEX IF NOT EXISTS "intel_feature_flag_feature_tenant_id_key"
  ON "intel_feature_flag"("feature", "tenant_id");

DO $$
DECLARE
  index_columns text;
BEGIN
  SELECT pg_get_indexdef(indexrelid) INTO index_columns
  FROM pg_index
  WHERE indexrelid = 'intel_feature_flag_feature_enabled_idx'::regclass;
  IF index_columns IS NULL
     OR index_columns NOT LIKE '%(feature, enabled)%' THEN
    RAISE EXCEPTION 'intel_feature_flag_feature_enabled_idx has an incompatible definition';
  END IF;

  SELECT pg_get_indexdef(indexrelid) INTO index_columns
  FROM pg_index
  WHERE indexrelid = 'intel_feature_flag_feature_tenant_id_key'::regclass;
  IF index_columns IS NULL
     OR index_columns NOT LIKE '%(feature, tenant_id)%'
     OR index_columns NOT LIKE 'CREATE UNIQUE INDEX%' THEN
    RAISE EXCEPTION 'intel_feature_flag_feature_tenant_id_key has an incompatible definition';
  END IF;
END
$$;

ALTER TABLE "intel_feature_flag" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "intel_feature_flag" FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  policy_count integer;
  total_policy_count integer;
  policy_qual text;
  policy_check text;
  normalized_qual text;
  normalized_check text;
BEGIN
  SELECT count(*) INTO total_policy_count
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'intel_feature_flag';

  SELECT count(*), max(qual), max(with_check)
    INTO policy_count, policy_qual, policy_check
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'intel_feature_flag'
    AND policyname = 'intel_feature_flag_isolation';

  IF policy_count = 0 AND total_policy_count = 0 THEN
    CREATE POLICY "intel_feature_flag_isolation"
      ON "intel_feature_flag"
      USING (rls_bypass() OR tenant_id = current_tenant_id()::text)
      WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id()::text);
  ELSE
    -- pg_policies deparses equivalent grouping and casts differently across
    -- PostgreSQL releases. Remove only whitespace/grouping parentheses, then
    -- require the complete canonical expression; this rejects extra terms
    -- such as OR true rather than accepting a permissive substring match.
    normalized_qual := regexp_replace(COALESCE(policy_qual, ''), '[[:space:]()]', '', 'g');
    normalized_check := regexp_replace(COALESCE(policy_check, ''), '[[:space:]()]', '', 'g');
    IF policy_count <> 1
       OR total_policy_count <> 1
       OR normalized_qual <> 'rls_bypassORtenant_id=current_tenant_id::text'
       OR normalized_check <> 'rls_bypassORtenant_id=current_tenant_id::text' THEN
      RAISE EXCEPTION 'intel_feature_flag_isolation has an incompatible definition';
    END IF;
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "intel_feature_flag" TO capiro_app;
  END IF;
END
$$;

COMMIT;
