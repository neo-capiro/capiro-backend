-- Phase 1 ("One Memory, One Ledger") workstream 1A — additive governance and
-- temporal columns on memory_items, per the blueprint's canonical memory
-- model (Table 19: identity/scope, provenance/authority, time/state,
-- governance). Populated by the candidate write path (1B, its own migration)
-- and the confirm/correct/forget verbs (1D); existing rows backfill to safe
-- defaults inline below.
--
-- Purely additive: no existing column, index, or policy is touched. The RLS
-- policy replacement (owner-aware private-scope enforcement) is a SEPARATE
-- migration (1C) on its own clone-rehearsed deploy window, per the plan's
-- rollout discipline — do not fold it in here.
ALTER TABLE "memory_items"
  ADD COLUMN "status"                VARCHAR(16)  NOT NULL DEFAULT 'active',
  ADD COLUMN "last_confirmed_at"     TIMESTAMPTZ(6),
  ADD COLUMN "review_cadence_days"   INTEGER,
  ADD COLUMN "supersedes_id"         UUID,
  ADD COLUMN "contradicts_id"        UUID,
  ADD COLUMN "sensitivity"           VARCHAR(16)  NOT NULL DEFAULT 'normal',
  ADD COLUMN "retention_policy_jsonb" JSONB,
  ADD COLUMN "legal_hold"            BOOLEAN      NOT NULL DEFAULT false,
  ADD COLUMN "revoked_at"            TIMESTAMPTZ(6),
  ADD COLUMN "revoked_by"            UUID,
  ADD COLUMN "exportable"            BOOLEAN      NOT NULL DEFAULT true,
  ADD COLUMN "training_use"          VARCHAR(16)  NOT NULL DEFAULT 'excluded';

-- Closed state machine for status (mirrors the existing visibility_chk style).
ALTER TABLE "memory_items"
  ADD CONSTRAINT "memory_items_status_chk"
    CHECK ("status" IN ('active', 'superseded', 'revoked'));

-- Self-referencing supersession/contradiction links (blueprint §4.6.5 step 8:
-- "preserve history through supersession rather than destructive overwrite").
-- ON DELETE SET NULL: Phase 1 never hard-deletes memory_items (forget is a
-- soft revoke, 1D); this only guards a future retention-schedule purge from
-- being blocked by, or leaving a dangling pointer on, a superseded/
-- contradicted row.
ALTER TABLE "memory_items"
  ADD CONSTRAINT "memory_items_supersedes_fk"
    FOREIGN KEY ("supersedes_id") REFERENCES "memory_items"("id") ON DELETE SET NULL,
  ADD CONSTRAINT "memory_items_contradicts_fk"
    FOREIGN KEY ("contradicts_id") REFERENCES "memory_items"("id") ON DELETE SET NULL;

CREATE INDEX "memory_items_tenant_status_idx"
  ON "memory_items" ("tenant_id", "status");
