-- Phase 3 (Watch consistency backend) — additive only.
--
-- Promotes the Watch proposal identity WatcherService already embeds as
-- `[watch:<code>:<ids>]` inside sp_change_set.summary (parsed via
-- parseWatchMarker) to a real `watch_key` column, and adds the lineage +
-- permanent-dismissal machinery a version-aware revalidate needs:
--
--   * watch_key / replaces_change_set_id / superseded_by_change_set_id /
--     recheck_status / superseded_reason on sp_change_set — a revalidate that
--     reissues a stale-head proposal points the new row at the old one
--     (replaces_change_set_id) and marks the old row superseded pointing
--     forward (superseded_by_change_set_id), with recheck_status ('unchanged'
--     | 'updated') on the new row and a plain-language superseded_reason when
--     a proposal is dropped instead of reissued. Deliberately NOT Prisma
--     relations (see the schema comment) — audit pointers must keep resolving
--     after historical cleanup of either endpoint.
--   * `superseded` on sp_change_set_status — distinct from the existing
--     `stale` (which the generic/person-authored apply() path keeps using for
--     its own head-guard) so the new Watch-aware status never collides with
--     the older generic one.
--   * sp_watch_dismissal — a PERMANENT per-(strategy, watch_key) suppression,
--     because current Watcher logic may re-propose a rejected finding on its
--     next run and a dismissal must survive that.
--
-- Generated via `prisma migrate diff --from-schema-datamodel --to-schema-datamodel`
-- against the pre-Phase-3 schema (no live database reachable from this
-- worktree); RLS block hand-written to match every prior sp_* migration's
-- idiom. Same RLS caveat as every migration since G1: capiro_app currently
-- bypasses RLS (policies are the forward-ready DB boundary; real isolation is
-- the withTenant query hook).
--
-- ROLLBACK (manual, reverse order — additive migration, no data loss):
--   DROP INDEX IF EXISTS "sp_change_set_tenant_id_strategy_id_watch_key_status_idx";
--   DROP TABLE IF EXISTS "sp_watch_dismissal" CASCADE;
--   ALTER TABLE "sp_change_set" DROP COLUMN "watch_key";
--   ALTER TABLE "sp_change_set" DROP COLUMN "recheck_status";
--   ALTER TABLE "sp_change_set" DROP COLUMN "superseded_by_change_set_id";
--   ALTER TABLE "sp_change_set" DROP COLUMN "superseded_reason";
--   ALTER TABLE "sp_change_set" DROP COLUMN "replaces_change_set_id";
--   -- Postgres cannot DROP a single enum value; a true rollback of the
--   -- `superseded` addition would require recreating sp_change_set_status
--   -- (see 20260725130000_sp_run_recovery's identical ADD VALUE caveat).

-- PREREQUISITE: PostgreSQL 12+ (ALTER TYPE ... ADD VALUE inside a transaction
-- requires it; Prisma wraps each migration in one). The new enum value is not
-- referenced by any statement in this file, which is the other PG 12
-- requirement. Aurora PostgreSQL here is well past 12.

-- AlterEnum
ALTER TYPE "sp_change_set_status" ADD VALUE IF NOT EXISTS 'superseded';

-- AlterTable
ALTER TABLE "sp_change_set" ADD COLUMN     "recheck_status" TEXT,
ADD COLUMN     "replaces_change_set_id" UUID,
ADD COLUMN     "superseded_by_change_set_id" UUID,
ADD COLUMN     "superseded_reason" TEXT,
ADD COLUMN     "watch_key" TEXT;

-- CreateTable
CREATE TABLE "sp_watch_dismissal" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "strategy_id" UUID NOT NULL,
    "watch_key" TEXT NOT NULL,
    "dismissed_by_user_id" TEXT NOT NULL,
    "dismissed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source_change_set_id" UUID,

    CONSTRAINT "sp_watch_dismissal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sp_watch_dismissal_tenant_id_strategy_id_idx" ON "sp_watch_dismissal"("tenant_id", "strategy_id");

-- CreateIndex
CREATE UNIQUE INDEX "sp_watch_dismissal_tenant_id_strategy_id_watch_key_key" ON "sp_watch_dismissal"("tenant_id", "strategy_id", "watch_key");

-- CreateIndex
CREATE INDEX "sp_change_set_tenant_id_strategy_id_watch_key_status_idx" ON "sp_change_set"("tenant_id", "strategy_id", "watch_key", "status");

-- ---------------------------------------------------------------------------
-- Row-Level Security for the new table (same tenant-isolation policy as every
-- prior sp_* migration; the GUC helper functions current_tenant_id()/
-- rls_bypass() already exist from G1).
-- ---------------------------------------------------------------------------

ALTER TABLE "sp_watch_dismissal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sp_watch_dismissal" FORCE ROW LEVEL SECURITY;
CREATE POLICY "sp_watch_dismissal_isolation" ON "sp_watch_dismissal"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
