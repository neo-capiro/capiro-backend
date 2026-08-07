-- Funding Opportunities P07 — human decision and next action.
--
-- WHY THESE COLUMNS EXIST SEPARATELY FROM workflow_status
-- ------------------------------------------------------
-- `workflow_status` is where a pursuit IS ('suggested', 'pursuing', 'won', ...).
-- The human DECISION is a different fact: a team can decide to monitor something
-- that has no pursuit, and can decide to pass on something whose source is still
-- wide open. Folding the two together is what makes "we chose not to bid this"
-- indistinguishable from "the source closed", and only one of those is a decision
-- somebody can be asked about later.
--
-- The machine recommendation (P06) is a third, separate thing and is deliberately
-- NOT stored: it is recomputed on read so it cannot go stale against a client
-- profile that has since changed. So a row can carry `human_decision = 'pass'`
-- while today's recommendation says `pursue`, and that disagreement is signal
-- rather than corruption.
--
-- ADDITIVE AND NULLABLE, WITH NO DEFAULT
-- --------------------------------------
-- NULL means "nobody has decided yet", which is the correct state for every
-- existing row and for every future producer-created suggestion. A default of
-- 'monitor' would fabricate a decision for the entire corpus; a NOT NULL column
-- would require a backfill that invents one. No backfill is needed or wanted.
--
-- CHECK CONSTRAINTS, NOT A POSTGRES ENUM
-- --------------------------------------
-- Matching the existing `client_funding_opportunity_status_chk` and
-- `..._eligibility_chk`. A Postgres enum cannot have a value removed and its
-- ALTER path locks the table, so this repository's convention is a bounded CHECK
-- on a VARCHAR. Widening the vocabulary later is then one DROP/ADD CONSTRAINT
-- rather than a migration nobody wants to run during business hours.
--
-- RLS
-- ---
-- `client_funding_opportunity` already has RLS ENABLED and FORCED with four
-- tenant-predicated policies from 20260810010000. Adding columns does not change
-- any of that, and this migration deliberately does NOT re-create the policies:
-- re-issuing them would risk replacing a policy with a subtly different predicate.
-- The CI gate asserts enabled + forced + exactly four policies after replay.
--
-- Every statement is retry-safe. A failed migration blocks every later one, so a
-- retry after a partial failure must be a no-op.

ALTER TABLE "client_funding_opportunity"
    ADD COLUMN IF NOT EXISTS "human_decision" VARCHAR(16),
    ADD COLUMN IF NOT EXISTS "decision_reason" TEXT,
    ADD COLUMN IF NOT EXISTS "decision_at" TIMESTAMPTZ(6),
    ADD COLUMN IF NOT EXISTS "decision_by_user_id" UUID,
    ADD COLUMN IF NOT EXISTS "next_action" TEXT,
    ADD COLUMN IF NOT EXISTS "next_action_due_at" TIMESTAMPTZ(6);

-- The decision vocabulary. Deliberately NOT the same list as workflow_status:
-- 'monitor' and 'pass' have no workflow equivalent, and 'suggested'/'expired'
-- are machine states that no human decides.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'client_funding_opportunity_human_decision_chk'
  ) THEN
    ALTER TABLE "client_funding_opportunity"
      ADD CONSTRAINT "client_funding_opportunity_human_decision_chk"
      CHECK ("human_decision" IS NULL OR "human_decision" IN ('pursue', 'monitor', 'pass'));
  END IF;
END $$;

-- A decision must carry WHO and WHEN, or it is not reviewable. Enforced as a
-- three-way all-or-nothing rather than three independent NOT NULLs, because the
-- columns are only meaningful together and each is legitimately NULL on an
-- undecided row.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'client_funding_opportunity_decision_actor_chk'
  ) THEN
    ALTER TABLE "client_funding_opportunity"
      ADD CONSTRAINT "client_funding_opportunity_decision_actor_chk"
      CHECK (
        ("human_decision" IS NULL AND "decision_at" IS NULL AND "decision_by_user_id" IS NULL)
        OR ("human_decision" IS NOT NULL AND "decision_at" IS NOT NULL AND "decision_by_user_id" IS NOT NULL)
      );
  END IF;
END $$;

-- A due date with no action is a reminder about nothing. The reverse is fine: an
-- action can legitimately have no deadline.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'client_funding_opportunity_next_action_chk'
  ) THEN
    ALTER TABLE "client_funding_opportunity"
      ADD CONSTRAINT "client_funding_opportunity_next_action_chk"
      CHECK ("next_action_due_at" IS NULL OR "next_action" IS NOT NULL);
  END IF;
END $$;

-- The triage inbox (P10) reads "decided rows for this tenant, soonest action
-- first". Partial on human_decision so the index covers only decided rows, which
-- is a small fraction of the table and keeps the index cheap on a corpus that is
-- overwhelmingly machine suggestions.
CREATE INDEX IF NOT EXISTS "client_funding_opportunity_decision_idx"
    ON "client_funding_opportunity" ("tenant_id", "human_decision", "next_action_due_at")
    WHERE "human_decision" IS NOT NULL;
