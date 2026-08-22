-- LegiWatch Phase 9 — distinguish run/body/observation/event audit findings.
--
-- Runtime freshness, queue latency, and missing verification evidence are valid
-- run-level blockers and do not necessarily have a hearing or committee anchor.
-- Keep those findings durable rather than letting an over-strict anchor check
-- abort the readiness transaction.

ALTER TABLE "legiwatch_event_audit"
  ADD COLUMN IF NOT EXISTS "audit_scope" TEXT NOT NULL DEFAULT 'EVENT';

UPDATE "legiwatch_event_audit"
SET "audit_scope" = CASE
  WHEN "hearing_id" IS NOT NULL THEN 'EVENT'
  WHEN "observation_id" IS NOT NULL THEN 'OBSERVATION'
  WHEN "committee_system_code" IS NOT NULL THEN 'BODY'
  ELSE 'RUN'
END;

ALTER TABLE "legiwatch_event_audit"
  DROP CONSTRAINT IF EXISTS "legiwatch_event_audit_anchor_check";

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'legiwatch_event_audit_scope_check'
  ) THEN
    ALTER TABLE "legiwatch_event_audit"
      ADD CONSTRAINT "legiwatch_event_audit_scope_check" CHECK (
        audit_scope IN ('RUN', 'BODY', 'OBSERVATION', 'EVENT')
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'legiwatch_event_audit_scope_anchor_check'
  ) THEN
    ALTER TABLE "legiwatch_event_audit"
      ADD CONSTRAINT "legiwatch_event_audit_scope_anchor_check" CHECK (
        (audit_scope = 'RUN') OR
        (audit_scope = 'BODY' AND committee_system_code IS NOT NULL) OR
        (audit_scope = 'OBSERVATION' AND observation_id IS NOT NULL) OR
        (audit_scope = 'EVENT' AND hearing_id IS NOT NULL)
      );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS "legiwatch_event_audit_scope_idx"
  ON "legiwatch_event_audit" ("run_id", "audit_scope", "status", "gate_key");

COMMENT ON COLUMN "legiwatch_event_audit"."audit_scope" IS
  'RUN, BODY, OBSERVATION, or EVENT. RUN findings intentionally require no entity anchor.';
