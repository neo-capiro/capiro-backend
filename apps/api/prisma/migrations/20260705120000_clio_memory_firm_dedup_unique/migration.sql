-- Close the firm-memory duplicate hole in clio_memory.
--
-- The existing unique index clio_memory_tenant_scope_owner_key_uniq covers
-- (tenant_id, scope, owner_user_id, key). For user_private rows owner_user_id
-- is NOT NULL, so it correctly enforces one row per (tenant, scope, owner, key).
-- For firm rows owner_user_id IS NULL, and SQL treats NULLs as DISTINCT, so two
-- firm memories with the same (tenant, scope, key) do NOT collide — duplicates
-- accumulate silently. We add a PARTIAL unique index scoped to firm rows to
-- plug that hole, keeping the existing index (which still enforces the
-- user_private case). Both are needed; neither alone is sufficient.
--
-- Runs BEFORE the clio_memory RLS migration (20260705120100) on purpose: the
-- dedup DELETE below is a data write, and once FORCE ROW LEVEL SECURITY is on,
-- a migration-role write with no tenant/bypass GUC would match 0 rows.
--
-- NOTE (Prisma): partial (WHERE) unique indexes cannot be expressed in the
-- Prisma schema, so clio_memory_firm_key_uniq is intentionally NOT modeled in
-- schema.prisma (see the doc comment on the ClioMemory model). `prisma migrate
-- deploy` applies it fine; do NOT run `prisma migrate dev` and let it
-- "reconcile" drift by dropping this index.

-- 1) Remove pre-existing firm duplicates, keeping the most recently updated row
--    (tie-break on id so a group with identical updated_at still collapses to
--    one). Idempotent: a no-op when there are no duplicates.
DELETE FROM "clio_memory" a
USING "clio_memory" b
WHERE a."owner_user_id" IS NULL
  AND b."owner_user_id" IS NULL
  AND a."tenant_id" = b."tenant_id"
  AND a."scope" = b."scope"
  AND a."key" = b."key"
  AND (
    a."updated_at" < b."updated_at"
    OR (a."updated_at" = b."updated_at" AND a."id" < b."id")
  );

-- 2) Enforce firm-scope uniqueness going forward.
CREATE UNIQUE INDEX IF NOT EXISTS "clio_memory_firm_key_uniq"
  ON "clio_memory" ("tenant_id", "scope", "key")
  WHERE "owner_user_id" IS NULL;
