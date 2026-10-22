-- Give each client its own clio_memory keyspace. The existing partial unique
-- index covers every row without an owner, including scope='client', because
-- 20260705120000 predates client scope. Keep firm and user_private uniqueness.
-- This is a forward schema repair: do not deduplicate or delete memory rows.
-- Read back _prisma_migrations, the scope/owner/client CHECK, the old index,
-- and duplicate counts before applying this source migration in any DB.

BEGIN;

-- Hold writes through the preflight and index swap. CREATE INDEX also requires
-- this lock mode; an unsuccessful check rolls the entire migration back.
LOCK TABLE "clio_memory" IN SHARE MODE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    WHERE i.indexrelid = to_regclass('"clio_memory_firm_key_uniq"')
      AND i.indrelid = '"clio_memory"'::regclass
      AND i.indisunique
      AND i.indisvalid
      AND i.indisready
      AND i.indnkeyatts = 3
      AND i.indnatts = 3
      AND pg_get_indexdef(i.indexrelid, 1, true) = 'tenant_id'
      AND pg_get_indexdef(i.indexrelid, 2, true) = 'scope'
      AND pg_get_indexdef(i.indexrelid, 3, true) = 'key'
      AND pg_get_expr(i.indpred, i.indrelid) = '(owner_user_id IS NULL)'
  ) THEN
    RAISE EXCEPTION 'expected pre-client clio_memory_firm_key_uniq is absent or changed';
  END IF;

  -- Existing rows alone cannot prove the required guard still protects future
  -- writes. Compare canonical output exactly, preserving grouping and literals.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = '"clio_memory"'::regclass
      AND c.conname = 'clio_memory_scope_owner_check'
      AND c.contype = 'c' AND c.convalidated
      AND c.conkey = ARRAY[
        (SELECT a.attnum FROM pg_catalog.pg_attribute a
          WHERE a.attrelid = c.conrelid AND a.attname = 'scope'
            AND a.attnum > 0 AND NOT a.attisdropped),
        (SELECT a.attnum FROM pg_catalog.pg_attribute a
          WHERE a.attrelid = c.conrelid AND a.attname = 'owner_user_id'
            AND a.attnum > 0 AND NOT a.attisdropped),
        (SELECT a.attnum FROM pg_catalog.pg_attribute a
          WHERE a.attrelid = c.conrelid AND a.attname = 'client_id'
            AND a.attnum > 0 AND NOT a.attisdropped)
      ]::smallint[]
      AND pg_catalog.pg_get_expr(c.conbin, c.conrelid, false) = (
        $scope_shape$(((scope = 'firm'::text) AND (owner_user_id IS NULL) AND (client_id IS NULL))$scope_shape$ ||
        $scope_shape$ OR ((scope = 'user_private'::text) AND (owner_user_id IS NOT NULL) AND (client_id IS NULL))$scope_shape$ ||
        $scope_shape$ OR ((scope = 'client'::text) AND (owner_user_id IS NULL) AND (client_id IS NOT NULL)))$scope_shape$
      )
  ) THEN
    RAISE EXCEPTION 'expected client-aware clio_memory_scope_owner_check is absent or changed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "clio_memory"
    WHERE "scope" = 'client'
      AND ("owner_user_id" IS NOT NULL OR "client_id" IS NULL)
  ) THEN
    RAISE EXCEPTION 'client memory scope/owner/client shape is invalid';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "clio_memory"
    WHERE "scope" = 'firm'
      AND ("owner_user_id" IS NOT NULL OR "client_id" IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'firm memory scope/owner/client shape is invalid';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "clio_memory"
    WHERE "scope" = 'client'
    GROUP BY "tenant_id", "client_id", "key"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate client memory keys require owner review';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "clio_memory"
    WHERE "scope" = 'firm'
    GROUP BY "tenant_id", "key"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate firm memory keys require owner review';
  END IF;
END $$;

CREATE UNIQUE INDEX "clio_memory_client_key_uniq"
  ON "clio_memory" ("tenant_id", "client_id", "key")
  WHERE "scope" = 'client' AND "owner_user_id" IS NULL AND "client_id" IS NOT NULL;

-- Build the replacement before removing the old guard, then retain its public
-- name so source references and operations checks still identify it.
CREATE UNIQUE INDEX "clio_memory_firm_key_uniq_next"
  ON "clio_memory" ("tenant_id", "scope", "key")
  WHERE "scope" = 'firm' AND "owner_user_id" IS NULL;

DROP INDEX "clio_memory_firm_key_uniq";
ALTER INDEX "clio_memory_firm_key_uniq_next" RENAME TO "clio_memory_firm_key_uniq";

COMMIT;
