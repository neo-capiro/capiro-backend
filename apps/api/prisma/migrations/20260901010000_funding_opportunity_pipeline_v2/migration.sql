-- Funding Opportunities P35 — pursuit pipeline stages.
--
-- WHAT THIS ADDS
-- -------------------------------------------------------------------
--   client_funding_opportunity.pipeline_stage             the stage, NULLABLE
--   client_funding_opportunity.pipeline_stage_version     concurrency token
--   client_funding_opportunity.pipeline_stage_at          when it last moved
--   client_funding_opportunity.pipeline_stage_by_user_id  who moved it
--   funding_opportunity_stage_transition                  the audit trail
--
-- A SECOND COLUMN, NOT A WIDER workflow_status
-- -------------------------------------------------------------------
-- `workflow_status` already holds seven values and two of them are not capture
-- stages: `suggested` is the producer's own output and `expired` is a mechanical
-- consequence of the source closing. A capture pipeline needs `qualified` and
-- `submitted`, which that column has no room for, and it must NOT carry
-- `suggested`/`expired`, which it cannot drop without breaking every reader —
-- including the lifecycle processor, which decides what to alert on from it.
--
-- So the stage sits BESIDE the old column and the old column keeps working. That
-- is also what makes the rolling deploy safe.
--
-- ROLLING-DEPLOY SAFETY, CONCRETELY
-- -------------------------------------------------------------------
-- Old pods keep writing `workflow_status` and know nothing about
-- `pipeline_stage`. Three properties make that survivable:
--
--   1. `pipeline_stage` is NULLABLE with no default. An old pod's INSERT omits it
--      and succeeds; the row simply has no stage, which is TRUE.
--   2. `pipeline_stage_version` is NOT NULL DEFAULT 0, so an old pod's INSERT
--      still gets a valid token and the first new-code transition can use it.
--   3. Reads reconcile the two columns in ONE place
--      (`effectiveStage` in funding-opportunity-pipeline.ts): the legacy status
--      wins for anything it can express, and the stage only adds resolution the
--      legacy column cannot. So a row an old pod moved to `won` is never shown as
--      `pursuing` just because the stage did not follow.
--
-- WHAT THE BACKFILL DELIBERATELY DOES NOT DO
-- -------------------------------------------------------------------
--   saved     -> reviewing
--   pursuing  -> pursuing
--   dismissed -> passed
--   won       -> won
--   lost      -> lost
--   suggested -> NOTHING
--   expired   -> NOTHING
--
-- `suggested` is left unstaged because a machine suggestion nobody has opened is
-- not a human "reviewing" it. Mapping it would put the producer's entire backlog
-- onto a board column labelled with an activity nobody is performing — the same
-- false claim HUMAN_DECISION_STATUSES exists to prevent, drawn on a Kanban.
--
-- `expired` is left unstaged because Capiro does not know which stage a row was
-- in when the source closed underneath it. Picking one fabricates a capture
-- history, and `lost` in particular would claim a competition was lost.
--
-- The backfill sets `pipeline_stage_at` (from `updated_at`) but leaves
-- `pipeline_stage_by_user_id` NULL, and that NULL is meaningful rather than
-- missing: a NULL actor on a non-NULL stage means "inferred from the legacy
-- status by this migration", not "a person moved it". The read derives the basis
-- from exactly that, so no extra column is needed.
--
-- WHY won/lost CAN BE BACKFILLED THOUGH THE GRAPH FORBIDS REACHING THEM DIRECTLY
-- -------------------------------------------------------------------
-- ALLOWED_TRANSITIONS lets `won`/`lost` be reached only from `submitted`, because
-- a bid cannot be won if it was never submitted. That constrains MOVES. The
-- backfill is not a move; it is an initial position for a row whose outcome was
-- already recorded by an explicit human action months ago. Refusing to backfill
-- those would hide real, decided outcomes from the board.
--
-- THE AUDIT TABLE IS TENANT-SCOPED AND RLS-FORCED
-- -------------------------------------------------------------------
-- "Who moved this to `lost`, when, and why" is a fact about ONE team. Unlike the
-- provider catalog tables in this program, it carries `tenant_id`, RLS ENABLE +
-- FORCE, and four policies.
--
-- A CHECK requires a REASON for `submitted`, `won`, `lost` and `passed`. Enforced
-- in the database rather than only in the service, so a future caller that
-- bypasses the service still cannot record an outcome nobody explained.
--
-- FORWARD-ONLY AND RETRY-SAFE. Every statement is IF NOT EXISTS or a guarded
-- DO block; re-running is a no-op. Rehearsed against a fresh
-- pgvector/pgvector:pg16 with a clean replay, a retry, and constraint proofs by
-- ACTUAL INSERT.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The four columns.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "client_funding_opportunity"
    ADD COLUMN IF NOT EXISTS "pipeline_stage" VARCHAR(16);

ALTER TABLE "client_funding_opportunity"
    ADD COLUMN IF NOT EXISTS "pipeline_stage_version" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "client_funding_opportunity"
    ADD COLUMN IF NOT EXISTS "pipeline_stage_at" TIMESTAMPTZ(6);

ALTER TABLE "client_funding_opportunity"
    ADD COLUMN IF NOT EXISTS "pipeline_stage_by_user_id" UUID;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The bounded vocabulary.
--
-- Seven values, and NULL is admitted on purpose — it is the honest state for a
-- suggestion nobody has staged and for a row that expired before this existed.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'client_funding_opportunity_pipeline_stage_chk'
  ) THEN
    ALTER TABLE "client_funding_opportunity"
      ADD CONSTRAINT "client_funding_opportunity_pipeline_stage_chk"
      CHECK (
        "pipeline_stage" IS NULL
        OR "pipeline_stage" IN (
          'reviewing', 'qualified', 'pursuing', 'submitted', 'won', 'lost', 'passed'
        )
      );
  END IF;
END $$;

-- A stage always knows WHEN it was set. The actor is deliberately NOT required:
-- see the backfill note above. The reverse direction IS required — a timestamp or
-- an actor with no stage describes a move that did not happen.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'client_funding_opportunity_pipeline_stage_at_chk'
  ) THEN
    ALTER TABLE "client_funding_opportunity"
      ADD CONSTRAINT "client_funding_opportunity_pipeline_stage_at_chk"
      CHECK (
        ("pipeline_stage" IS NOT NULL AND "pipeline_stage_at" IS NOT NULL)
        OR (
          "pipeline_stage" IS NULL
          AND "pipeline_stage_at" IS NULL
          AND "pipeline_stage_by_user_id" IS NULL
        )
      );
  END IF;
END $$;

-- The token only ever moves forward.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'client_funding_opportunity_pipeline_version_chk'
  ) THEN
    ALTER TABLE "client_funding_opportunity"
      ADD CONSTRAINT "client_funding_opportunity_pipeline_version_chk"
      CHECK ("pipeline_stage_version" >= 0);
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. The board index.
--
-- The board's counts come from a GROUP BY over every workflow row a client has,
-- never from a fetched page — a paged count silently under-reports the moment a
-- client passes one page of saved opportunities. This index is what makes that
-- aggregate cheap.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS "client_funding_opportunity_pipeline_stage_idx"
    ON "client_funding_opportunity" ("tenant_id", "client_id", "pipeline_stage");

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. The audit trail.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "funding_opportunity_stage_transition" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "client_funding_opportunity_id" UUID NOT NULL,

    -- NULL means "entered the pipeline", which is a real and common first entry.
    "from_stage" VARCHAR(16),
    "to_stage" VARCHAR(16) NOT NULL,

    -- NOT NULL. There is no way to record a stage move nobody performed, which is
    -- what "producers cannot alter stage" means at the schema level.
    "actor_user_id" UUID NOT NULL,
    "reason" TEXT,

    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "funding_opportunity_stage_transition_pkey" PRIMARY KEY ("id"),

    CONSTRAINT "funding_opportunity_stage_transition_to_chk"
        CHECK ("to_stage" IN (
          'reviewing', 'qualified', 'pursuing', 'submitted', 'won', 'lost', 'passed'
        )),

    CONSTRAINT "funding_opportunity_stage_transition_from_chk"
        CHECK (
          "from_stage" IS NULL
          OR "from_stage" IN (
            'reviewing', 'qualified', 'pursuing', 'submitted', 'won', 'lost', 'passed'
          )
        ),

    -- A move to where it already was is not a move.
    CONSTRAINT "funding_opportunity_stage_transition_distinct_chk"
        CHECK ("from_stage" IS NULL OR "from_stage" <> "to_stage"),

    -- The outcome stages REQUIRE a stated reason. A recorded loss nobody explained
    -- is a loss nobody can learn from, and a pass nobody explained is one the team
    -- will re-litigate from scratch next quarter. Enforced here as well as in the
    -- service so a caller that bypasses the service still cannot do it.
    CONSTRAINT "funding_opportunity_stage_transition_reason_chk"
        CHECK (
          "to_stage" NOT IN ('submitted', 'won', 'lost', 'passed')
          OR ("reason" IS NOT NULL AND btrim("reason") <> '')
        ),

    CONSTRAINT "funding_opportunity_stage_transition_tenant_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE CASCADE,

    -- Same-tenant FK, and CASCADE: an audit row whose subject was deleted with
    -- its client would be a retained tenant fact with nothing to attach it to.
    CONSTRAINT "funding_opportunity_stage_transition_row_fkey"
        FOREIGN KEY ("client_funding_opportunity_id")
        REFERENCES "client_funding_opportunity" ("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "funding_opportunity_stage_transition_row_idx"
    ON "funding_opportunity_stage_transition"
       ("tenant_id", "client_funding_opportunity_id", "occurred_at" DESC);

CREATE INDEX IF NOT EXISTS "funding_opportunity_stage_transition_actor_idx"
    ON "funding_opportunity_stage_transition" ("tenant_id", "actor_user_id", "occurred_at" DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. RLS. ENABLE and FORCE, four policies.
--
-- FORCE matters: without it the table owner bypasses every policy, and the
-- application connects as the owner in some environments.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "funding_opportunity_stage_transition" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "funding_opportunity_stage_transition" FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'funding_opportunity_stage_transition'
      AND policyname = 'funding_opportunity_stage_transition_select'
  ) THEN
    CREATE POLICY "funding_opportunity_stage_transition_select"
        ON "funding_opportunity_stage_transition"
        FOR SELECT USING (rls_bypass() OR tenant_id = current_tenant_id());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'funding_opportunity_stage_transition'
      AND policyname = 'funding_opportunity_stage_transition_insert'
  ) THEN
    CREATE POLICY "funding_opportunity_stage_transition_insert"
        ON "funding_opportunity_stage_transition"
        FOR INSERT WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'funding_opportunity_stage_transition'
      AND policyname = 'funding_opportunity_stage_transition_update'
  ) THEN
    CREATE POLICY "funding_opportunity_stage_transition_update"
        ON "funding_opportunity_stage_transition"
        FOR UPDATE USING (rls_bypass() OR tenant_id = current_tenant_id())
        WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'funding_opportunity_stage_transition'
      AND policyname = 'funding_opportunity_stage_transition_delete'
  ) THEN
    CREATE POLICY "funding_opportunity_stage_transition_delete"
        ON "funding_opportunity_stage_transition"
        FOR DELETE USING (rls_bypass() OR tenant_id = current_tenant_id());
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. The backfill.
--
-- IDEMPOTENT: scoped to rows with no stage yet, so a re-run touches nothing and
-- a later human transition is never reverted by a repeated deploy.
--
-- No transition rows are written. The backfill is not a move — there was no
-- actor, and inventing one would put a person's name against a decision they did
-- not make.
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE "client_funding_opportunity"
   SET "pipeline_stage" = CASE "workflow_status"
                            WHEN 'saved'     THEN 'reviewing'
                            WHEN 'pursuing'  THEN 'pursuing'
                            WHEN 'dismissed' THEN 'passed'
                            WHEN 'won'       THEN 'won'
                            WHEN 'lost'      THEN 'lost'
                          END,
       "pipeline_stage_at" = "updated_at"
 WHERE "pipeline_stage" IS NULL
   AND "workflow_status" IN ('saved', 'pursuing', 'dismissed', 'won', 'lost');
