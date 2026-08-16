-- Phase 5 durable canonical-entity backfill checkpoints.
--
-- Source rows remain the source of truth; this table records the resumable
-- high-water mark and page accounting for each tenant/source scope. NULL
-- tenant_id is reserved for system/global public-source backfills.

CREATE TABLE "canonical_entity_backfill_checkpoints" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id" UUID,
  "source" VARCHAR(64) NOT NULL,
  "source_cursor" TEXT,
  "status" VARCHAR(24) NOT NULL DEFAULT 'running',
  "scanned" INTEGER NOT NULL DEFAULT 0,
  "created" INTEGER NOT NULL DEFAULT 0,
  "linked" INTEGER NOT NULL DEFAULT 0,
  "ambiguous" INTEGER NOT NULL DEFAULT 0,
  "skipped" INTEGER NOT NULL DEFAULT 0,
  "failed" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMPTZ(6),

  CONSTRAINT "canonical_entity_backfill_checkpoints_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "canonical_entity_backfill_checkpoints_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "canonical_entity_backfill_checkpoints_source_check"
    CHECK ("source" ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT "canonical_entity_backfill_checkpoints_status_check"
    CHECK ("status" IN ('running', 'completed', 'failed')),
  CONSTRAINT "canonical_entity_backfill_checkpoints_counts_check"
    CHECK (
      "scanned" >= 0 AND "created" >= 0 AND "linked" >= 0
      AND "ambiguous" >= 0 AND "skipped" >= 0 AND "failed" >= 0
    ),
  CONSTRAINT "canonical_entity_backfill_checkpoints_terminal_state_check"
    CHECK (
      ("status" = 'running' AND "completed_at" IS NULL)
      OR
      ("status" = 'completed' AND "completed_at" IS NOT NULL AND "last_error" IS NULL)
      OR
      ("status" = 'failed' AND "completed_at" IS NULL AND "last_error" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "canonical_entity_backfill_checkpoints_global_source_unique"
  ON "canonical_entity_backfill_checkpoints" ("source")
  WHERE "tenant_id" IS NULL;
CREATE UNIQUE INDEX "canonical_entity_backfill_checkpoints_tenant_source_unique"
  ON "canonical_entity_backfill_checkpoints" ("tenant_id", "source")
  WHERE "tenant_id" IS NOT NULL;
CREATE INDEX "canonical_entity_backfill_checkpoints_tenant_status_idx"
  ON "canonical_entity_backfill_checkpoints" ("tenant_id", "status", "updated_at" DESC);

CREATE OR REPLACE FUNCTION touch_canonical_entity_backfill_checkpoint_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "canonical_entity_backfill_checkpoints_touch_updated_at"
  BEFORE UPDATE ON "canonical_entity_backfill_checkpoints"
  FOR EACH ROW EXECUTE FUNCTION touch_canonical_entity_backfill_checkpoint_updated_at();

CREATE OR REPLACE FUNCTION reject_completed_canonical_entity_backfill_checkpoint_mutation()
RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'completed' THEN
    RAISE EXCEPTION
      'Completed canonical entity backfill checkpoints are immutable; start a new source run'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "canonical_entity_backfill_checkpoints_reject_completed_mutation"
  BEFORE UPDATE ON "canonical_entity_backfill_checkpoints"
  FOR EACH ROW EXECUTE FUNCTION reject_completed_canonical_entity_backfill_checkpoint_mutation();

ALTER TABLE "canonical_entity_backfill_checkpoints" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "canonical_entity_backfill_checkpoints" FORCE ROW LEVEL SECURITY;
CREATE POLICY "canonical_entity_backfill_checkpoints_visible_read"
  ON "canonical_entity_backfill_checkpoints"
  FOR SELECT
  USING (rls_bypass() OR "tenant_id" = current_tenant_id());
CREATE POLICY "canonical_entity_backfill_checkpoints_tenant_insert"
  ON "canonical_entity_backfill_checkpoints"
  FOR INSERT
  WITH CHECK (rls_bypass() OR "tenant_id" = current_tenant_id());
CREATE POLICY "canonical_entity_backfill_checkpoints_tenant_update"
  ON "canonical_entity_backfill_checkpoints"
  FOR UPDATE
  USING (rls_bypass() OR "tenant_id" = current_tenant_id())
  WITH CHECK (rls_bypass() OR "tenant_id" = current_tenant_id());
CREATE POLICY "canonical_entity_backfill_checkpoints_no_delete"
  ON "canonical_entity_backfill_checkpoints"
  FOR DELETE
  USING (false);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE "canonical_entity_backfill_checkpoints" TO capiro_app;
    REVOKE DELETE, TRUNCATE ON TABLE "canonical_entity_backfill_checkpoints" FROM capiro_app;
  END IF;
END
$$;

COMMENT ON TABLE "canonical_entity_backfill_checkpoints" IS
  'Durable resumability and bounded accounting for tenant-private and global canonical entity backfills.';
COMMENT ON COLUMN "canonical_entity_backfill_checkpoints"."source_cursor" IS
  'Stable source-native keyset cursor. NULL means the run has not processed a source row.';
COMMENT ON FUNCTION reject_completed_canonical_entity_backfill_checkpoint_mutation() IS
  'Completed checkpoint evidence is terminal and cannot be rewritten.';

-- Keep Prisma introspection/schema parity explicit without asking Prisma Migrate
-- to replace this SQL-owned table or any of its RLS/index/trigger contracts.
