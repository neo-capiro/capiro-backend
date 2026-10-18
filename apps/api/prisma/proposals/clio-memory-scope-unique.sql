-- HISTORICAL SOURCE PROPOSAL ONLY. Do not execute directly. The central owner
-- allocated and promoted this design to
-- migrations/20281018080000_clio_memory_scope_unique/migration.sql, with
-- explicit index, row-shape, and duplicate preflight. Review that migration
-- and the DB readback before any application.
-- Depends on 20260713020000_memory_client_scope_ephemeral, which added
-- clio_memory.client_id and the scope/owner/client shape constraint.
--
-- The current clio_memory_firm_key_uniq WHERE owner_user_id IS NULL also
-- includes client rows, so one ordinary key cannot exist for two clients in
-- the same tenant. Preserve firm uniqueness and the independent Prisma
-- user_private owner-key uniqueness while giving each client its own keyspace.
-- No row deduplication or data deletion belongs to this migration.

BEGIN;

CREATE UNIQUE INDEX "clio_memory_client_key_uniq"
  ON "clio_memory" ("tenant_id", "client_id", "key")
  WHERE "scope" = 'client' AND "owner_user_id" IS NULL AND "client_id" IS NOT NULL;

DROP INDEX "clio_memory_firm_key_uniq";

CREATE UNIQUE INDEX "clio_memory_firm_key_uniq"
  ON "clio_memory" ("tenant_id", "scope", "key")
  WHERE "scope" = 'firm' AND "owner_user_id" IS NULL;

COMMIT;
