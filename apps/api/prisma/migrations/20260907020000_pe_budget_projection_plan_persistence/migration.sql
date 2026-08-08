-- Phase 7 Gap 5, decision 3 — persist Phase 4/5/6 projection plans.
--
-- INHERITED PREREQUISITE DEFECT, like the candidate-metadata migration that
-- precedes it. Phase 7 authorization binds to an exact set of proposed
-- canonical mutations; `defense_budget_promotion_eligibility.document` carries
-- `projectionPlanIds` and `projectionPlanHashes` and every downstream gate
-- treats them as reloadable evidence. They never were: the family planners
-- compute a plan in memory, report its `contentSha256`, and discard it when the
-- command exits. `git log --all -S"projection_plan" -- apps/api/prisma` finds no
-- commit on any branch that ever created a table for them.
--
-- A hash whose object cannot be independently reloaded is not evidence, so
-- persistence was assumed by the design rather than deliberately deferred. See
-- Gap 5 in docs/defense-budget/PHASE-7-ARCHITECTURE-GAPS.md.
--
-- One substrate for all three producers rather than three mechanisms. Ownership
-- stays with the producer — Phase 4 writes RDT&E plans, Phase 5 non-RDT&E,
-- Phase 6 congressional — and Phase 7 only ever reads. Nothing in the promotion
-- path may recompute a family projection.
--
-- Append-only, using the same `enforce_promotion_ledger_append_only` trigger
-- every other ledger table in this schema uses. A projection plan is a fact
-- about what a producer computed from a certified input set at a moment in
-- time. A changed input set is a *new* plan with a new content hash, exactly as
-- a changed promotion plan requires a new plan ID.
--
-- Storage choice: the plan document lands in JSONB. The alternative — an
-- immutable content-addressed locator plus a byte hash — is better for plans
-- large enough to strain a row, so `plan_locator` exists alongside
-- `plan_document` with a CHECK requiring exactly one. That way moving large
-- plans to object storage later is a data migration rather than a schema
-- change, and the "exactly one" constraint makes a half-migrated row
-- impossible.

CREATE TABLE "defense_budget_projection_plan" (
    "id"                      UUID NOT NULL DEFAULT gen_random_uuid(),
    "projection_plan_id"      TEXT NOT NULL,
    "record_schema_version"   TEXT NOT NULL,
    "schema_version"          TEXT NOT NULL,
    "family"                  TEXT NOT NULL,
    "cycle_id"                TEXT NOT NULL,
    "fiscal_year"             INTEGER NOT NULL,
    "content_sha256"          CHAR(64) NOT NULL,
    "producer_version"        TEXT NOT NULL,
    "certification_id"        TEXT,
    "certification_sha256"    CHAR(64) NOT NULL,
    "artifact_set_sha256"     CHAR(64) NOT NULL,
    "status"                  VARCHAR(32) NOT NULL,
    "conflict_count"          INTEGER NOT NULL,
    "unsupported_count"       INTEGER NOT NULL,
    "plan_document"           JSONB,
    "plan_locator"            TEXT,
    "plan_byte_sha256"        CHAR(64),
    "created_at"              TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "defense_budget_projection_plan_pkey" PRIMARY KEY ("id"),

    -- Content-addressed identity. The same plan computed twice is one row, so a
    -- producer re-run is a replay rather than a second plan.
    CONSTRAINT "defense_budget_projection_plan_identity_unique"
        UNIQUE ("projection_plan_id"),

    CONSTRAINT "defense_budget_projection_plan_status_check"
        CHECK ("status" IN ('PROJECTABLE', 'BLOCKED')),

    -- The denormalized counts are a summary of the stored document, and the
    -- status must agree with them. A row claiming PROJECTABLE while carrying a
    -- nonzero count is refused by the database, not merely by the reader that
    -- happens to look.
    CONSTRAINT "defense_budget_projection_plan_status_agrees_check"
        CHECK (
            ("status" = 'PROJECTABLE' AND "conflict_count" = 0 AND "unsupported_count" = 0)
            OR ("status" = 'BLOCKED' AND ("conflict_count" > 0 OR "unsupported_count" > 0))
        ),

    CONSTRAINT "defense_budget_projection_plan_counts_check"
        CHECK ("conflict_count" >= 0 AND "unsupported_count" >= 0),

    -- Exactly one storage mode. Inline JSONB today; a locator plus its byte
    -- hash when a family's plans outgrow a row.
    CONSTRAINT "defense_budget_projection_plan_storage_check"
        CHECK (
            ("plan_document" IS NOT NULL AND "plan_locator" IS NULL AND "plan_byte_sha256" IS NULL)
            OR ("plan_document" IS NULL AND "plan_locator" IS NOT NULL AND "plan_byte_sha256" IS NOT NULL)
        )
);

-- The eligibility read is scoped by cycle and families together.
CREATE INDEX "defense_budget_projection_plan_scope_idx"
    ON "defense_budget_projection_plan" ("cycle_id", "family", "fiscal_year");

CREATE INDEX "defense_budget_projection_plan_content_idx"
    ON "defense_budget_projection_plan" ("content_sha256");

-- Same append-only enforcement as every other promotion ledger table. Declared
-- as a BEFORE row trigger rather than trusted to grants, because
-- ALTER DEFAULT PRIVILEGES re-grants DML to capiro_app on every new table.
CREATE TRIGGER "defense_budget_projection_plan_append_only"
    BEFORE UPDATE OR DELETE ON "defense_budget_projection_plan"
    FOR EACH ROW EXECUTE FUNCTION enforce_promotion_ledger_append_only();
