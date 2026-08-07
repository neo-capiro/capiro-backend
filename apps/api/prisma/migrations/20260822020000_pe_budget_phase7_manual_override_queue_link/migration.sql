-- Phase 7 Workstream K — link the legacy reconciliation queue to the governed
-- proposal raised from it.
--
-- Separate from 20260822010000 on purpose. That migration is purely additive
-- and an architecture test asserts it contains no ALTER TABLE, because a
-- canonical-storage migration that quietly reshapes a legacy product table is
-- exactly the kind of change that is hard to review and harder to roll back.
-- This one is explicitly about touching a pre-existing table, and does only
-- that.
--
-- Under the two-step flow an entry can no longer go straight from `open` to
-- `resolved`. Proposing a correction parks it at `pending_approval`; it
-- resolves when a second capiro_admin approves the override it points at.
-- Without this column the queue would forget which correction it was waiting
-- on.

ALTER TABLE "reconciliation_review_queue"
  ADD COLUMN "proposed_override_id" UUID;

-- Nullable and unconstrained for existing rows: every entry queued before this
-- migration predates the governed path and legitimately points at nothing.
ALTER TABLE "reconciliation_review_queue"
  ADD CONSTRAINT "reconciliation_review_queue_proposed_override_fkey"
  FOREIGN KEY ("proposed_override_id")
  REFERENCES "defense_budget_manual_override"("override_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- One entry per proposal: a correction is raised from exactly one queue entry,
-- so two entries pointing at the same override would mean one of them is lying
-- about what it is waiting on.
CREATE UNIQUE INDEX "reconciliation_review_queue_proposed_override_key"
    ON "reconciliation_review_queue" ("proposed_override_id")
    WHERE "proposed_override_id" IS NOT NULL;

COMMENT ON COLUMN "reconciliation_review_queue"."proposed_override_id" IS
  'Phase 7 Workstream K: the governed manual override proposed from this entry. Set when the entry moves to pending_approval; the entry resolves when that override is approved by a second capiro_admin.';
