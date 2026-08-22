-- LegiWatch Phase 9 — explicit provenance-ledger disposition.
--
-- A source observation must be either linked to one canonical hearing or carry
-- an explicit conflict/invalid reason. Leaving an unlinked row silently pending
-- is a launch blocker; it is never counted as represented coverage.

ALTER TABLE "hearing_source_observation"
  ADD COLUMN IF NOT EXISTS "reconciliation_status" TEXT NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS "reconciliation_reason_code" TEXT,
  ADD COLUMN IF NOT EXISTS "reconciliation_reviewed_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "reconciliation_reviewed_by" TEXT;

UPDATE "hearing_source_observation"
SET "reconciliation_status" = 'RECONCILED',
    "reconciliation_reason_code" = COALESCE(
      "reconciliation_reason_code",
      'CANONICAL_HEARING_LINKED'
    ),
    "reconciliation_reviewed_at" = COALESCE(
      "reconciliation_reviewed_at",
      "last_seen_at",
      now()
    ),
    "reconciliation_reviewed_by" = COALESCE(
      "reconciliation_reviewed_by",
      'phase9-migration-backfill'
    )
WHERE "hearing_id" IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'hearing_source_observation_reconciliation_status_check'
  ) THEN
    ALTER TABLE "hearing_source_observation"
      ADD CONSTRAINT "hearing_source_observation_reconciliation_status_check"
      CHECK (
        "reconciliation_status" IN (
          'PENDING', 'RECONCILED', 'CONFLICT', 'IGNORED_INVALID'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'hearing_source_observation_reconciliation_shape_check'
  ) THEN
    ALTER TABLE "hearing_source_observation"
      ADD CONSTRAINT "hearing_source_observation_reconciliation_shape_check"
      CHECK (
        (
          "reconciliation_status" = 'RECONCILED'
          AND "hearing_id" IS NOT NULL
          AND "reconciliation_reason_code" IS NOT NULL
        ) OR (
          "reconciliation_status" IN ('CONFLICT', 'IGNORED_INVALID')
          AND "hearing_id" IS NULL
          AND "reconciliation_reason_code" IS NOT NULL
        ) OR (
          "reconciliation_status" = 'PENDING'
          AND "hearing_id" IS NULL
        )
      );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS "hearing_source_observation_reconciliation_idx"
  ON "hearing_source_observation" (
    "reconciliation_status", "last_seen_at" DESC
  );
CREATE INDEX IF NOT EXISTS "hearing_source_observation_pending_idx"
  ON "hearing_source_observation" ("source_id", "last_seen_at" DESC)
  WHERE "reconciliation_status" = 'PENDING';

COMMENT ON COLUMN "hearing_source_observation"."reconciliation_status" IS
  'Phase 9 disposition: PENDING, RECONCILED, CONFLICT, or IGNORED_INVALID. PENDING is a launch blocker.';
COMMENT ON COLUMN "hearing_source_observation"."reconciliation_reason_code" IS
  'Auditable reason for the reconciliation disposition; required outside PENDING.';
