-- Phase 6 — governed ingestion provenance (master plan gap #4). Additive +
-- reversible + idempotent. Ships DARK: the ledger starts empty and every
-- projected row defaults review_state='auto' with NULL run/ingested_at, so
-- existing rows + recall are byte-identical (same rationale as the walls
-- additive migration 20260719220000). Provenance stamping begins only when the
-- ingest paths pass an IngestContext.

-- 1. The ingest-run ledger: one row per backfill/cron/write-through/correction
--    pass, with actor + trigger + counts, so no memory reaches the store without
--    an auditable "who/when/which-pass" trail.
CREATE TABLE IF NOT EXISTS "memory_ingest_run" (
  "id"            UUID           NOT NULL DEFAULT uuid_generate_v4(),
  "tenant_id"     UUID           NOT NULL,
  "trigger"       VARCHAR(24)    NOT NULL,
  "actor_user_id" UUID,
  "started_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "finished_at"   TIMESTAMPTZ(6),
  "status"        VARCHAR(16)    NOT NULL DEFAULT 'running',
  "counts_jsonb"  JSONB          NOT NULL DEFAULT '{}',
  CONSTRAINT "memory_ingest_run_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "memory_ingest_run_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "memory_ingest_run_trigger_chk" CHECK ("trigger" IN ('cron','manual_backfill','write_through','correction')),
  CONSTRAINT "memory_ingest_run_status_chk" CHECK ("status" IN ('running','completed','failed'))
);
CREATE INDEX IF NOT EXISTS "memory_ingest_run_tenant_started_idx"
  ON "memory_ingest_run" ("tenant_id", "started_at" DESC);

-- RLS: tenant isolation, the standard pattern (20260501000000). DB-enforced now
-- that dev is role-hardened; prod inherits when hardened.
ALTER TABLE "memory_ingest_run" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "memory_ingest_run" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "memory_ingest_run_isolation" ON "memory_ingest_run";
CREATE POLICY "memory_ingest_run_isolation" ON "memory_ingest_run"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "memory_ingest_run" TO capiro_app;
  END IF;
END $$;

-- 2. Provenance columns on the projected store.
ALTER TABLE "memory_items" ADD COLUMN IF NOT EXISTS "ingest_run_id" UUID;
ALTER TABLE "memory_items" ADD COLUMN IF NOT EXISTS "ingested_at"   TIMESTAMPTZ(6);
ALTER TABLE "memory_items" ADD COLUMN IF NOT EXISTS "review_state"  VARCHAR(16) NOT NULL DEFAULT 'auto';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_items_review_state_chk') THEN
    ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_review_state_chk"
      CHECK ("review_state" IN ('auto','unreviewed','confirmed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_items_ingest_run_fk') THEN
    ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_ingest_run_fk"
      FOREIGN KEY ("ingest_run_id") REFERENCES "memory_ingest_run"("id") ON DELETE SET NULL;
  END IF;
END $$;
-- Cheap "what's awaiting review" scan for the learned-surface UI (partial index).
CREATE INDEX IF NOT EXISTS "memory_items_unreviewed_idx"
  ON "memory_items" ("tenant_id") WHERE "review_state" = 'unreviewed';

-- ROLLBACK (reversible, non-lossy for existing data):
--   ALTER TABLE memory_items DROP CONSTRAINT IF EXISTS memory_items_ingest_run_fk,
--     DROP CONSTRAINT IF EXISTS memory_items_review_state_chk,
--     DROP COLUMN IF EXISTS review_state, DROP COLUMN IF EXISTS ingested_at,
--     DROP COLUMN IF EXISTS ingest_run_id;
--   DROP TABLE IF EXISTS memory_ingest_run;
