-- Phase 7 Workstream D — canonical snapshot storage, promotion ledger, and
-- least-privilege database boundary.
--
-- Purely additive. No existing table is altered, no canonical data is
-- backfilled, and no legacy writer is disabled here (that is Workstream M).
--
-- ---------------------------------------------------------------------------
-- Why the enforcement is triggers and not only grants
-- ---------------------------------------------------------------------------
-- Migration 20260502020000 gives capiro_app `ALTER DEFAULT PRIVILEGES ... GRANT
-- SELECT, INSERT, UPDATE, DELETE ON TABLES`, so every table created by the
-- master role automatically becomes writable by the general API serve role.
-- The out-of-band ops script scripts/sql/2026-07-19-rls-role-hardening.sql
-- additionally runs `GRANT ALL ON ALL TABLES IN SCHEMA public TO capiro_app`
-- and is expected to be re-run after future role work.
--
-- That means a canonical table protected only by REVOKE would silently become
-- writable again the next time either of those runs. Grants are therefore
-- defence in depth here, and the binding control is a BEFORE row trigger, which
-- fires for every role including the table owner. This is the same conclusion
-- migration 20260718000000 reached for the audit tables.
--
-- Two distinct rules are enforced by that trigger:
--   1. Only the promotion role (or the table owner, which is the migration and
--      rehearsal identity) may write a canonical row at all.
--   2. Rows belonging to a snapshot that is no longer STAGING are immutable for
--      everyone, including the promoter. Corrections arrive as a new snapshot.
--
-- ---------------------------------------------------------------------------
-- Storage shape
-- ---------------------------------------------------------------------------
-- Canonical facts land in one snapshot-scoped table, `defense_budget_canonical_row`,
-- discriminated by `canonical_entity` — the destination vocabulary declared by
-- the Workstream B mapping registry. The Phase 4-6 native tables
-- (procurement_budget_line, om_sag, milcon_project, program_element*, ...) are
-- NOT reused as canonical storage: none of them carries a snapshot id, a
-- promotion run id, or a canonical row hash, so none is snapshot-ready in the
-- sense Workstream D requires, and Phase 7's plan directs adding
-- snapshot-scoped tables in exactly that case.
--
-- A single discriminated table rather than ~29 typed twins is a deliberate
-- choice: snapshot immutability, row hashing, provenance completeness, and the
-- writer-role boundary are uniform across every family, so expressing them once
-- makes them provable once. The typed value axes are still separated at the
-- column level — money, quantity, and unit cost are distinct NUMERIC columns
-- and money additionally carries its exact printed string and unit — so a count
-- can never be summed as dollars. Family-shaped read models are Workstream M's
-- compatibility projections, built from this substrate rather than replacing it.

-- ===========================================================================
-- 1. Snapshots and the activation pointer
-- ===========================================================================

CREATE TABLE "defense_budget_canonical_snapshot" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "snapshot_key" TEXT NOT NULL,
    "domain" VARCHAR(64) NOT NULL DEFAULT 'defense_budget',
    "environment" VARCHAR(32) NOT NULL,
    "cycle_id" TEXT NOT NULL,
    "fiscal_year" INTEGER NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'STAGING',
    -- Scopes the snapshot must cover before it may be activated, and the
    -- scopes staging has actually completed. Activation compares the two.
    "required_scopes" JSONB NOT NULL DEFAULT '[]',
    "completed_scopes" JSONB NOT NULL DEFAULT '[]',
    "snapshot_hash" CHAR(64),
    "mapping_registry_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "activated_at" TIMESTAMPTZ(6),
    "superseded_at" TIMESTAMPTZ(6),
    CONSTRAINT "defense_budget_canonical_snapshot_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "defense_budget_canonical_snapshot_key_unique" UNIQUE ("snapshot_key"),
    CONSTRAINT "defense_budget_canonical_snapshot_status_check"
        CHECK ("status" IN ('STAGING', 'READY', 'ACTIVE', 'SUPERSEDED', 'ROLLED_BACK', 'FAILED')),
    CONSTRAINT "defense_budget_canonical_snapshot_hash_check"
        CHECK ("snapshot_hash" IS NULL OR "snapshot_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "defense_budget_canonical_snapshot_registry_hash_check"
        CHECK ("mapping_registry_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "defense_budget_canonical_snapshot_required_scopes_check"
        CHECK (jsonb_typeof("required_scopes") = 'array'),
    CONSTRAINT "defense_budget_canonical_snapshot_completed_scopes_check"
        CHECK (jsonb_typeof("completed_scopes") = 'array'),
    -- A snapshot that claims to be usable must carry the hash that identifies it.
    CONSTRAINT "defense_budget_canonical_snapshot_ready_needs_hash_check"
        CHECK ("status" NOT IN ('READY', 'ACTIVE', 'SUPERSEDED') OR "snapshot_hash" IS NOT NULL)
);

CREATE INDEX "defense_budget_canonical_snapshot_status_idx"
    ON "defense_budget_canonical_snapshot" ("domain", "environment", "status");
CREATE INDEX "defense_budget_canonical_snapshot_cycle_idx"
    ON "defense_budget_canonical_snapshot" ("cycle_id", "fiscal_year");

COMMENT ON TABLE "defense_budget_canonical_snapshot" IS
  'Phase 7: an immutable annual canonical snapshot. Rows become visible to product reads only when defense_budget_active_snapshot points at this row. Owned by the promotion boundary; writable only by capiro_pe_promoter.';

-- The activation pointer. Exactly one row per (domain, environment) — the
-- uniqueness constraint is what makes "one active snapshot" a database fact
-- rather than a convention.
CREATE TABLE "defense_budget_active_snapshot" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "domain" VARCHAR(64) NOT NULL DEFAULT 'defense_budget',
    "environment" VARCHAR(32) NOT NULL,
    "snapshot_id" UUID NOT NULL,
    "activation_id" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "defense_budget_active_snapshot_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "defense_budget_active_snapshot_singleton_unique" UNIQUE ("domain", "environment"),
    CONSTRAINT "defense_budget_active_snapshot_snapshot_fkey"
        FOREIGN KEY ("snapshot_id") REFERENCES "defense_budget_canonical_snapshot"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE
);

COMMENT ON TABLE "defense_budget_active_snapshot" IS
  'Phase 7: the atomic activation pointer. Changing this single row is the entire act of making a snapshot visible. One row per domain/environment, enforced by defense_budget_active_snapshot_singleton_unique.';

-- ===========================================================================
-- 2. Plan, authorization, run, item
-- ===========================================================================

CREATE TABLE "defense_budget_promotion_plan" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "plan_id" TEXT NOT NULL,
    "plan_hash" CHAR(64) NOT NULL,
    "eligibility_hash" CHAR(64) NOT NULL,
    "mapping_registry_version" TEXT NOT NULL,
    "mapping_registry_hash" CHAR(64) NOT NULL,
    "cycle_id" TEXT NOT NULL,
    "fiscal_year" INTEGER NOT NULL,
    "scope" JSONB NOT NULL,
    "scope_hash" CHAR(64) NOT NULL,
    "mode" VARCHAR(32) NOT NULL,
    "expected_active_snapshot_id" UUID,
    "proposed_snapshot_id" UUID NOT NULL,
    "item_count" INTEGER NOT NULL,
    "blocked_count" INTEGER NOT NULL,
    "plan_document" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "defense_budget_promotion_plan_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "defense_budget_promotion_plan_plan_id_unique" UNIQUE ("plan_id"),
    -- A plan is identified by its hash: the same plan_id may not be re-filed
    -- with different content.
    CONSTRAINT "defense_budget_promotion_plan_identity_unique" UNIQUE ("plan_id", "plan_hash"),
    CONSTRAINT "defense_budget_promotion_plan_mode_check"
        CHECK ("mode" IN ('baseline_hydration', 'new_cycle', 'correction', 'rollback')),
    CONSTRAINT "defense_budget_promotion_plan_hash_check"
        CHECK ("plan_hash" ~ '^[0-9a-f]{64}$' AND "eligibility_hash" ~ '^[0-9a-f]{64}$'
               AND "scope_hash" ~ '^[0-9a-f]{64}$' AND "mapping_registry_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "defense_budget_promotion_plan_counts_check"
        CHECK ("item_count" >= 0 AND "blocked_count" >= 0 AND "blocked_count" <= "item_count")
);

CREATE INDEX "defense_budget_promotion_plan_cycle_idx"
    ON "defense_budget_promotion_plan" ("cycle_id", "fiscal_year");

COMMENT ON TABLE "defense_budget_promotion_plan" IS
  'Phase 7: an immutable, read-only promotion plan. Authorization binds to plan_id + plan_hash, so any change to a plan requires a new plan and a new authorization.';

CREATE TABLE "defense_budget_promotion_authorization" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "authorization_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "plan_hash" CHAR(64) NOT NULL,
    "eligibility_hash" CHAR(64) NOT NULL,
    "scope_hash" CHAR(64) NOT NULL,
    "expected_active_snapshot_id" UUID,
    "authorizer_actor_id" TEXT NOT NULL,
    "authorizer_role" VARCHAR(32) NOT NULL,
    "reason" TEXT NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "segregation" JSONB NOT NULL,
    "change_request_reference" TEXT,
    "authorization_hash" CHAR(64) NOT NULL,
    -- One-use bookkeeping. Both columns transition NULL -> value exactly once.
    "consumed_at" TIMESTAMPTZ(6),
    "consumed_by_run_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "defense_budget_promotion_authorization_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "defense_budget_promotion_authorization_id_unique" UNIQUE ("authorization_id"),
    CONSTRAINT "defense_budget_promotion_authorization_plan_fkey"
        FOREIGN KEY ("plan_id") REFERENCES "defense_budget_promotion_plan"("plan_id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "defense_budget_promotion_authorization_role_check"
        CHECK ("authorizer_role" = 'capiro_admin'),
    CONSTRAINT "defense_budget_promotion_authorization_expiry_check"
        CHECK ("expires_at" > "issued_at"),
    CONSTRAINT "defense_budget_promotion_authorization_reason_check"
        CHECK (btrim("reason") <> ''),
    CONSTRAINT "defense_budget_promotion_authorization_hash_check"
        CHECK ("authorization_hash" ~ '^[0-9a-f]{64}$' AND "plan_hash" ~ '^[0-9a-f]{64}$'),
    -- Consumption is all-or-nothing: a run id without a timestamp, or a
    -- timestamp without a run id, is a half-recorded redemption.
    CONSTRAINT "defense_budget_promotion_authorization_consumed_check"
        CHECK (("consumed_at" IS NULL) = ("consumed_by_run_id" IS NULL))
);

-- One-use, enforced by the database: a given authorization can be attached to
-- at most one run, and a run can consume at most one authorization.
CREATE UNIQUE INDEX "defense_budget_promotion_authorization_one_use_key"
    ON "defense_budget_promotion_authorization" ("consumed_by_run_id")
    WHERE "consumed_by_run_id" IS NOT NULL;

COMMENT ON TABLE "defense_budget_promotion_authorization" IS
  'Phase 7: an immutable, expiring, one-use promotion authorization issued by a capiro_admin. Append-only apart from a single NULL -> value consumption transition, enforced by defense_budget_promotion_authorization_append_only.';

CREATE TABLE "defense_budget_promotion_run" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_key" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "plan_hash" CHAR(64) NOT NULL,
    "authorization_id" TEXT NOT NULL,
    "snapshot_id" UUID NOT NULL,
    "expected_active_snapshot_id" UUID,
    "executor_identity" TEXT NOT NULL,
    "execution_mode" VARCHAR(32) NOT NULL DEFAULT 'execute',
    "status" VARCHAR(48) NOT NULL DEFAULT 'STAGING',
    "staged_row_count" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "committed_at" TIMESTAMPTZ(6),
    "failed_at" TIMESTAMPTZ(6),
    "failure_reason" TEXT,
    CONSTRAINT "defense_budget_promotion_run_pkey" PRIMARY KEY ("id"),
    -- Deterministic key so a retried execution resumes rather than duplicating.
    CONSTRAINT "defense_budget_promotion_run_key_unique" UNIQUE ("run_key"),
    CONSTRAINT "defense_budget_promotion_run_plan_fkey"
        FOREIGN KEY ("plan_id") REFERENCES "defense_budget_promotion_plan"("plan_id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "defense_budget_promotion_run_authorization_fkey"
        FOREIGN KEY ("authorization_id") REFERENCES "defense_budget_promotion_authorization"("authorization_id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "defense_budget_promotion_run_snapshot_fkey"
        FOREIGN KEY ("snapshot_id") REFERENCES "defense_budget_canonical_snapshot"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "defense_budget_promotion_run_status_check"
        CHECK ("status" IN ('STAGING', 'STAGED', 'READY', 'ACTIVATING', 'COMMITTED',
                            'SIDE_EFFECTS_PENDING', 'COMPLETED', 'FAILED_PRECOMMIT',
                            'COMMITTED_WITH_SIDE_EFFECT_FAILURE', 'CANCELLED')),
    CONSTRAINT "defense_budget_promotion_run_mode_check"
        CHECK ("execution_mode" IN ('execute', 'dry_run', 'resume'))
);

CREATE INDEX "defense_budget_promotion_run_status_idx"
    ON "defense_budget_promotion_run" ("status");

COMMENT ON TABLE "defense_budget_promotion_run" IS
  'Phase 7: one execution of one authorized plan. run_key is deterministic so a retry resumes the same run instead of creating a second one.';

CREATE TABLE "defense_budget_promotion_item" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "canonical_entity" VARCHAR(80) NOT NULL,
    "canonical_natural_key" TEXT NOT NULL,
    "operation" VARCHAR(16) NOT NULL,
    "prior_row_hash" CHAR(64),
    "proposed_row_hash" CHAR(64),
    "source_projection_id" TEXT NOT NULL,
    "source_projection_hash" CHAR(64) NOT NULL,
    "alert_disposition" VARCHAR(40) NOT NULL,
    "block_reason" VARCHAR(64),
    "staged_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "defense_budget_promotion_item_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "defense_budget_promotion_item_run_fkey"
        FOREIGN KEY ("run_id") REFERENCES "defense_budget_promotion_run"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "defense_budget_promotion_item_identity_unique"
        UNIQUE ("run_id", "canonical_entity", "canonical_natural_key"),
    CONSTRAINT "defense_budget_promotion_item_operation_check"
        CHECK ("operation" IN ('INSERT', 'SUPERSEDE', 'UNCHANGED', 'CORRECTION', 'BLOCKED')),
    -- A blocked item has no proposed row; every other operation must name one.
    CONSTRAINT "defense_budget_promotion_item_hash_presence_check"
        CHECK (("operation" = 'BLOCKED') = ("proposed_row_hash" IS NULL)),
    CONSTRAINT "defense_budget_promotion_item_block_reason_check"
        CHECK (("operation" = 'BLOCKED') = ("block_reason" IS NOT NULL))
);

COMMENT ON TABLE "defense_budget_promotion_item" IS
  'Phase 7: the authorized row set of a run, one row per canonical natural key. Staging may not write a canonical row that has no item here.';

-- ===========================================================================
-- 3. Activation ledger, rollback record, outbox, compatibility runs
-- ===========================================================================

CREATE TABLE "defense_budget_promotion_activation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "activation_key" TEXT NOT NULL,
    "run_id" UUID NOT NULL,
    "domain" VARCHAR(64) NOT NULL DEFAULT 'defense_budget',
    "environment" VARCHAR(32) NOT NULL,
    "previous_snapshot_id" UUID,
    "new_snapshot_id" UUID NOT NULL,
    "authorization_id" TEXT NOT NULL,
    "activation_kind" VARCHAR(24) NOT NULL DEFAULT 'PROMOTION',
    "activated_by" TEXT NOT NULL,
    "activated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "defense_budget_promotion_activation_pkey" PRIMARY KEY ("id"),
    -- Exactly-once activation. A retry that races to commit twice loses here.
    CONSTRAINT "defense_budget_promotion_activation_key_unique" UNIQUE ("activation_key"),
    CONSTRAINT "defense_budget_promotion_activation_run_fkey"
        FOREIGN KEY ("run_id") REFERENCES "defense_budget_promotion_run"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "defense_budget_promotion_activation_new_snapshot_fkey"
        FOREIGN KEY ("new_snapshot_id") REFERENCES "defense_budget_canonical_snapshot"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "defense_budget_promotion_activation_prev_snapshot_fkey"
        FOREIGN KEY ("previous_snapshot_id") REFERENCES "defense_budget_canonical_snapshot"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "defense_budget_promotion_activation_kind_check"
        CHECK ("activation_kind" IN ('PROMOTION', 'ROLLBACK')),
    CONSTRAINT "defense_budget_promotion_activation_distinct_check"
        CHECK ("previous_snapshot_id" IS NULL OR "previous_snapshot_id" <> "new_snapshot_id")
);

CREATE INDEX "defense_budget_promotion_activation_new_snapshot_idx"
    ON "defense_budget_promotion_activation" ("new_snapshot_id");

COMMENT ON TABLE "defense_budget_promotion_activation" IS
  'Phase 7: append-only activation ledger. An ambiguous commit result is resolved by reading this table, never by blind retry. activation_key makes activation exactly-once.';

CREATE TABLE "defense_budget_rollback_record" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "rollback_key" TEXT NOT NULL,
    "from_snapshot_id" UUID NOT NULL,
    "to_snapshot_id" UUID NOT NULL,
    "authorization_id" TEXT NOT NULL,
    "activation_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "defense_budget_rollback_record_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "defense_budget_rollback_record_key_unique" UNIQUE ("rollback_key"),
    CONSTRAINT "defense_budget_rollback_record_from_fkey"
        FOREIGN KEY ("from_snapshot_id") REFERENCES "defense_budget_canonical_snapshot"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "defense_budget_rollback_record_to_fkey"
        FOREIGN KEY ("to_snapshot_id") REFERENCES "defense_budget_canonical_snapshot"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "defense_budget_rollback_record_activation_fkey"
        FOREIGN KEY ("activation_id") REFERENCES "defense_budget_promotion_activation"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "defense_budget_rollback_record_distinct_check"
        CHECK ("from_snapshot_id" <> "to_snapshot_id"),
    CONSTRAINT "defense_budget_rollback_record_reason_check"
        CHECK (btrim("reason") <> '')
);

COMMENT ON TABLE "defense_budget_rollback_record" IS
  'Phase 7: rollback is a forward audited pointer transition to a prior immutable snapshot. ON DELETE RESTRICT on both snapshot references is what makes "rollback never deletes history" a database guarantee.';

CREATE TABLE "defense_budget_promotion_outbox" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "activation_id" UUID NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "old_snapshot_id" UUID,
    "new_snapshot_id" UUID NOT NULL,
    "canonical_entity" VARCHAR(80) NOT NULL,
    "canonical_natural_key" TEXT NOT NULL,
    "family" VARCHAR(24) NOT NULL,
    "fiscal_year" INTEGER,
    "funding_field" VARCHAR(32),
    "stage" VARCHAR(40),
    -- Exact money on both sides of the change. NUMERIC, never float.
    "old_original_value" TEXT,
    "old_value_millions" NUMERIC(24, 9),
    "new_original_value" TEXT,
    "new_value_millions" NUMERIC(24, 9),
    "change_classification" VARCHAR(40) NOT NULL,
    "suppress_alert" BOOLEAN NOT NULL,
    "is_correction" BOOLEAN NOT NULL DEFAULT false,
    "is_rollback" BOOLEAN NOT NULL DEFAULT false,
    "source_lineage" JSONB NOT NULL DEFAULT '{}',
    "status" VARCHAR(24) NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "processed_at" TIMESTAMPTZ(6),
    CONSTRAINT "defense_budget_promotion_outbox_pkey" PRIMARY KEY ("id"),
    -- Exactly-once downstream delivery.
    CONSTRAINT "defense_budget_promotion_outbox_dedupe_unique" UNIQUE ("dedupe_key"),
    CONSTRAINT "defense_budget_promotion_outbox_activation_fkey"
        FOREIGN KEY ("activation_id") REFERENCES "defense_budget_promotion_activation"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "defense_budget_promotion_outbox_status_check"
        CHECK ("status" IN ('PENDING', 'PROCESSING', 'DONE', 'FAILED', 'POISON')),
    CONSTRAINT "defense_budget_promotion_outbox_classification_check"
        CHECK ("change_classification" IN ('initial_hydration', 'material_change', 'correction',
                                           'rollback', 'unchanged', 'identity_change')),
    -- Hydration, corrections, and rollbacks may never carry an un-suppressed
    -- alert out of the database.
    CONSTRAINT "defense_budget_promotion_outbox_suppression_check"
        CHECK ("change_classification" NOT IN ('initial_hydration', 'correction', 'rollback', 'unchanged')
               OR "suppress_alert" = true),
    CONSTRAINT "defense_budget_promotion_outbox_attempts_check" CHECK ("attempts" >= 0)
);

CREATE INDEX "defense_budget_promotion_outbox_drain_idx"
    ON "defense_budget_promotion_outbox" ("status", "created_at");
CREATE INDEX "defense_budget_promotion_outbox_activation_idx"
    ON "defense_budget_promotion_outbox" ("activation_id");

COMMENT ON TABLE "defense_budget_promotion_outbox" IS
  'Phase 7: downstream effects, written inside the activation transaction and drained afterwards. defense_budget_promotion_outbox_suppression_check makes "hydration, corrections, and rollback never alert" a database guarantee rather than application policy.';

CREATE TABLE "defense_budget_compatibility_projection_run" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "snapshot_id" UUID NOT NULL,
    "activation_id" UUID,
    "status" VARCHAR(24) NOT NULL DEFAULT 'PENDING',
    "rows_written" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "finished_at" TIMESTAMPTZ(6),
    "error_text" TEXT,
    CONSTRAINT "defense_budget_compatibility_projection_run_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "defense_budget_compatibility_projection_run_snapshot_fkey"
        FOREIGN KEY ("snapshot_id") REFERENCES "defense_budget_canonical_snapshot"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "defense_budget_compatibility_projection_run_status_check"
        CHECK ("status" IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED'))
);

COMMENT ON TABLE "defense_budget_compatibility_projection_run" IS
  'Phase 7: rebuild of the legacy-shaped compatibility read models from an active snapshot. A failure here sets side-effect status and is replayable; it never invalidates the snapshot.';

-- ===========================================================================
-- 4. Canonical rows
-- ===========================================================================

CREATE TABLE "defense_budget_canonical_row" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "snapshot_id" UUID NOT NULL,
    "promotion_run_id" UUID NOT NULL,
    "canonical_entity" VARCHAR(80) NOT NULL,
    "canonical_natural_key" TEXT NOT NULL,
    "parent_natural_key" TEXT,
    "family" VARCHAR(24) NOT NULL,
    "fiscal_year" INTEGER,
    "funding_field" VARCHAR(32),
    "stage" VARCHAR(40),
    "canonical_row_hash" CHAR(64) NOT NULL,

    -- Value axes. Money carries its exact printed string and unit alongside the
    -- normalized millions figure; quantity and unit cost are separate columns
    -- so neither can be summed as money.
    "money_original_value" TEXT,
    "money_original_unit" VARCHAR(16),
    "money_value_millions" NUMERIC(24, 9),
    "quantity" NUMERIC(24, 9),
    "unit_cost_dollars" NUMERIC(24, 9),
    "text_value" TEXT,
    "date_value" DATE,
    "attributes" JSONB NOT NULL DEFAULT '{}',

    -- Lineage. Every column here is required by Workstream B's
    -- CANONICAL_LINEAGE_FIELDS_V1 and is copied, never recomputed.
    "direct_or_derived" VARCHAR(20) NOT NULL,
    "binding_status" VARCHAR(24) NOT NULL DEFAULT 'not_applicable',
    "source_projection_id" TEXT NOT NULL,
    "source_assertion_id" TEXT NOT NULL,
    "evidence_ids" JSONB NOT NULL,
    "artifact_id" TEXT NOT NULL,
    "artifact_content_sha256" CHAR(64) NOT NULL,
    "verification_candidate_id" TEXT NOT NULL,
    "verification_run_id" TEXT NOT NULL,
    "source_document_id" TEXT NOT NULL,
    "source_pdf_sha256" CHAR(64) NOT NULL,
    "mapping_registry_hash" CHAR(64) NOT NULL,
    "enactment_proof_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "defense_budget_canonical_row_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "defense_budget_canonical_row_snapshot_fkey"
        FOREIGN KEY ("snapshot_id") REFERENCES "defense_budget_canonical_snapshot"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "defense_budget_canonical_row_run_fkey"
        FOREIGN KEY ("promotion_run_id") REFERENCES "defense_budget_promotion_run"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,

    -- One row per canonical natural key per snapshot. This is what makes
    -- "no last-wins" true at the storage layer: a second write of the same key
    -- into the same snapshot fails rather than overwriting.
    CONSTRAINT "defense_budget_canonical_row_identity_unique"
        UNIQUE ("snapshot_id", "canonical_entity", "canonical_natural_key"),

    CONSTRAINT "defense_budget_canonical_row_hash_check"
        CHECK ("canonical_row_hash" ~ '^[0-9a-f]{64}$'
               AND "artifact_content_sha256" ~ '^[0-9a-f]{64}$'
               AND "source_pdf_sha256" ~ '^[0-9a-f]{64}$'
               AND "mapping_registry_hash" ~ '^[0-9a-f]{64}$'),

    CONSTRAINT "defense_budget_canonical_row_direct_or_derived_check"
        CHECK ("direct_or_derived" IN ('direct', 'derived', 'not_applicable')),

    -- A candidate or conflicting identity binding is review data, not canonical
    -- truth, and may not exist in a canonical row at all.
    CONSTRAINT "defense_budget_canonical_row_binding_check"
        CHECK ("binding_status" IN ('accepted', 'not_applicable')),

    -- The money triple is all-or-nothing: a row cannot carry a normalized
    -- amount with no printed original, which is how a rounded value would hide.
    CONSTRAINT "defense_budget_canonical_row_money_triple_check"
        CHECK (num_nonnulls("money_original_value", "money_original_unit", "money_value_millions") IN (0, 3)),

    CONSTRAINT "defense_budget_canonical_row_money_unit_check"
        CHECK ("money_original_unit" IS NULL
               OR "money_original_unit" IN ('dollars', 'thousands', 'millions')),

    -- An enacted position without its enactment proof cannot be stored.
    CONSTRAINT "defense_budget_canonical_row_enacted_proof_check"
        CHECK ("funding_field" <> 'enacted' OR "enactment_proof_id" IS NOT NULL),

    CONSTRAINT "defense_budget_canonical_row_funding_field_check"
        CHECK ("funding_field" IS NULL OR "funding_field" IN
               ('request', 'hascMark', 'sascMark', 'hacDMark', 'sacDMark',
                'ndaaConference', 'conference', 'enacted', 'reprogrammed', 'executed')),

    CONSTRAINT "defense_budget_canonical_row_stage_check"
        CHECK ("stage" IS NULL OR "stage" IN
               ('hasc', 'sasc', 'ndaa_conference', 'hac_d', 'sac_d',
                'appropriations_conference', 'public_law', 'continuing_resolution',
                'reprogramming', 'execution')),

    -- Stage-to-field authority, repeated at the storage layer. This is the
    -- database's copy of STAGE_AUTHORITY_FIELD: an authorization-track stage
    -- physically cannot write an appropriations field, and NDAA conference
    -- physically cannot write the appropriations conference field.
    --
    -- Every field except 'request' is owned by some stage authority, so a row
    -- carrying one must name the stage that published it. Leaving "stage" NULL
    -- is not an escape hatch: without the IS NOT NULL arm below, a request-side
    -- Phase 4/5 row could assert a congressional mark simply by declaring no
    -- stage, and this constraint would pass trivially.
    CONSTRAINT "defense_budget_canonical_row_stage_field_check"
        CHECK ("funding_field" IS NULL OR "funding_field" = 'request' OR (
            "stage" IS NOT NULL AND (
            ("stage" = 'hasc' AND "funding_field" = 'hascMark') OR
            ("stage" = 'sasc' AND "funding_field" = 'sascMark') OR
            ("stage" = 'ndaa_conference' AND "funding_field" = 'ndaaConference') OR
            ("stage" = 'hac_d' AND "funding_field" = 'hacDMark') OR
            ("stage" = 'sac_d' AND "funding_field" = 'sacDMark') OR
            ("stage" = 'appropriations_conference' AND "funding_field" = 'conference') OR
            ("stage" = 'public_law' AND "funding_field" = 'enacted') OR
            ("stage" = 'continuing_resolution' AND "funding_field" = 'enacted') OR
            ("stage" = 'reprogramming' AND "funding_field" = 'reprogrammed') OR
            ("stage" = 'execution' AND "funding_field" = 'executed')
        ))),

    CONSTRAINT "defense_budget_canonical_row_evidence_check"
        CHECK (jsonb_typeof("evidence_ids") = 'array')
);

CREATE INDEX "defense_budget_canonical_row_snapshot_entity_idx"
    ON "defense_budget_canonical_row" ("snapshot_id", "canonical_entity");
CREATE INDEX "defense_budget_canonical_row_parent_idx"
    ON "defense_budget_canonical_row" ("snapshot_id", "canonical_entity", "parent_natural_key");
CREATE INDEX "defense_budget_canonical_row_fy_idx"
    ON "defense_budget_canonical_row" ("snapshot_id", "family", "fiscal_year");
CREATE INDEX "defense_budget_canonical_row_run_idx"
    ON "defense_budget_canonical_row" ("promotion_run_id");

COMMENT ON TABLE "defense_budget_canonical_row" IS
  'Phase 7: snapshot-scoped canonical truth, discriminated by canonical_entity from the Workstream B mapping registry. Writable only by capiro_pe_promoter, and immutable once its snapshot leaves STAGING. Corrections arrive as a new snapshot, never as an UPDATE.';

COMMENT ON COLUMN "defense_budget_canonical_row"."money_value_millions" IS
  'Exact NUMERIC(24,9). Money is never a floating-point value anywhere in the promotion path; money_original_value preserves the printed decimal string.';

-- ===========================================================================
-- 5. Append-only audit of eligibility and authorization attempts (WS A.9)
-- ===========================================================================

CREATE TABLE "defense_budget_promotion_audit" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "attempt_kind" VARCHAR(32) NOT NULL,
    "outcome" VARCHAR(16) NOT NULL,
    "actor_id" TEXT,
    "cycle_id" TEXT,
    "scope" JSONB,
    "eligibility_hash" CHAR(64),
    "plan_id" TEXT,
    "plan_hash" CHAR(64),
    "authorization_id" TEXT,
    "expected_active_snapshot_id" UUID,
    "reasons" JSONB NOT NULL DEFAULT '[]',
    "detail" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "defense_budget_promotion_audit_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "defense_budget_promotion_audit_kind_check"
        CHECK ("attempt_kind" IN ('ELIGIBILITY', 'AUTHORIZATION', 'REDEMPTION')),
    CONSTRAINT "defense_budget_promotion_audit_outcome_check"
        CHECK ("outcome" IN ('ALLOWED', 'REFUSED')),
    CONSTRAINT "defense_budget_promotion_audit_reasons_check"
        CHECK (jsonb_typeof("reasons") = 'array'),
    -- A refusal that records no reason is not an audit record.
    CONSTRAINT "defense_budget_promotion_audit_refusal_reason_check"
        CHECK ("outcome" <> 'REFUSED' OR jsonb_array_length("reasons") > 0)
);

CREATE INDEX "defense_budget_promotion_audit_created_idx"
    ON "defense_budget_promotion_audit" ("created_at");
CREATE INDEX "defense_budget_promotion_audit_plan_idx"
    ON "defense_budget_promotion_audit" ("plan_id");

COMMENT ON TABLE "defense_budget_promotion_audit" IS
  'Phase 7 Workstream A.9: append-only record of every eligibility, authorization, and redemption attempt, allowed or refused. Refusals are the interesting half and are never discarded.';

-- ===========================================================================
-- 5b. Workstream K — the governed manual-override overlay
-- ===========================================================================
--
-- A human correction to a published number, held BESIDE the snapshot rather
-- than inside it. It is deliberately not a source observation and deliberately
-- not a column on defense_budget_canonical_row: a promoted canonical row
-- records what the government published, and a human decision has no business
-- travelling inside it.
--
-- Immutable and versioned. Amending or revoking inserts a new version linked
-- through prior_override_id; the append-only trigger below refuses UPDATE and
-- DELETE outright, so the history of who changed a published figure, when, and
-- why cannot be rewritten.

CREATE TABLE "defense_budget_manual_override" (
    "override_id"        UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Target: a canonical identity, never a legacy peCode.
    "canonical_entity"      TEXT NOT NULL,
    "canonical_natural_key" TEXT NOT NULL,
    "fiscal_year"           INTEGER,
    "funding_field"         VARCHAR(32),

    -- The asserted value. Printed figure and unit as text, normalized millions
    -- as NUMERIC(24,9) — the same representation defense_budget_canonical_row
    -- uses, so an override and the value it overrides compare exactly.
    "money_original_value"  TEXT NOT NULL,
    "money_original_unit"   TEXT NOT NULL,
    "money_value_millions"  NUMERIC(24,9) NOT NULL,

    -- Governance.
    "author_actor_id"    TEXT NOT NULL,
    "approver_actor_id"  TEXT NOT NULL,
    "approver_role"      TEXT NOT NULL,
    "reason"             TEXT NOT NULL,
    "evidence_ids"       JSONB NOT NULL,
    "change_request_ref" TEXT,

    "status"             TEXT NOT NULL,
    "version"            INTEGER NOT NULL,
    "prior_override_id"  UUID REFERENCES "defense_budget_manual_override"("override_id"),

    "effective_from"     TIMESTAMPTZ(6) NOT NULL,
    "effective_to"       TIMESTAMPTZ(6),
    "approved_at"        TIMESTAMPTZ(6) NOT NULL,
    "revoked_at"         TIMESTAMPTZ(6),

    "override_hash"      CHAR(64) NOT NULL,
    "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    -- Segregation of duties, repeated at the storage layer. The application
    -- enforces this inside the Zod schema; a direct SQL writer bypasses the
    -- application, so the database refuses it too.
    CONSTRAINT "defense_budget_manual_override_author_not_approver_check"
        CHECK ("author_actor_id" <> "approver_actor_id"),

    CONSTRAINT "defense_budget_manual_override_approver_role_check"
        CHECK ("approver_role" = 'capiro_admin'),

    CONSTRAINT "defense_budget_manual_override_status_check"
        CHECK ("status" IN ('approved', 'revoked')),

    -- Expiry is derived from the dates at read time, never stored, so an
    -- override cannot outlive its window because a job failed to flip a flag.
    -- What the database does enforce is that the window is coherent.
    CONSTRAINT "defense_budget_manual_override_window_check"
        CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from"),

    CONSTRAINT "defense_budget_manual_override_revoked_check"
        CHECK (("status" = 'revoked') = ("revoked_at" IS NOT NULL)),

    CONSTRAINT "defense_budget_manual_override_money_unit_check"
        CHECK ("money_original_unit" IN ('dollars', 'thousands', 'millions')),

    CONSTRAINT "defense_budget_manual_override_funding_field_check"
        CHECK ("funding_field" IS NULL OR "funding_field" IN
               ('request', 'hascMark', 'sascMark', 'hacDMark', 'sacDMark',
                'ndaaConference', 'conference', 'enacted', 'reprogrammed', 'executed')),

    -- A correction supersedes; it never edits. Version 1 begins a chain and
    -- names no predecessor; every later version must name the one it replaces.
    CONSTRAINT "defense_budget_manual_override_version_check"
        CHECK ("version" > 0),
    CONSTRAINT "defense_budget_manual_override_chain_check"
        CHECK (("version" = 1) = ("prior_override_id" IS NULL)),

    CONSTRAINT "defense_budget_manual_override_evidence_check"
        CHECK (jsonb_typeof("evidence_ids") = 'array' AND jsonb_array_length("evidence_ids") > 0)
);

-- One version number per target identity. A second v2 for the same target is a
-- concurrent edit, and the loser must reload rather than fork the chain.
CREATE UNIQUE INDEX "defense_budget_manual_override_target_version_key"
    ON "defense_budget_manual_override"
       ("canonical_entity", "canonical_natural_key",
        COALESCE("fiscal_year", -1), COALESCE("funding_field", ''), "version");

-- A superseded version is pointed at exactly once, so the chain is a line.
CREATE UNIQUE INDEX "defense_budget_manual_override_prior_key"
    ON "defense_budget_manual_override" ("prior_override_id")
    WHERE "prior_override_id" IS NOT NULL;

CREATE INDEX "defense_budget_manual_override_target_idx"
    ON "defense_budget_manual_override"
       ("canonical_entity", "canonical_natural_key", "fiscal_year", "funding_field");

COMMENT ON TABLE "defense_budget_manual_override" IS
  'Phase 7 Workstream K: immutable, versioned human corrections applied beside the active snapshot at read time. Never a source observation, never a column on a canonical row. Append-only; author may not be approver.';

-- ===========================================================================
-- 6. The promotion database role
-- ===========================================================================
--
-- Created here with a placeholder password, exactly as capiro_app was in
-- migration 20260502020000. The bootstrap-roles ECS task rotates it to the
-- value held in its own Secrets Manager secret. Until that runs, the role
-- cannot authenticate, because the placeholder is not stored anywhere.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_pe_promoter') THEN
    CREATE ROLE capiro_pe_promoter LOGIN PASSWORD 'placeholder-rotate-via-bootstrap-roles';
  END IF;
END
$$;

-- No CREATEDB, no CREATEROLE, no SUPERUSER, no BYPASSRLS, no replication.
ALTER ROLE capiro_pe_promoter
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

GRANT CONNECT ON DATABASE capiro TO capiro_pe_promoter;
GRANT USAGE ON SCHEMA public TO capiro_pe_promoter;

-- Read the verified upstream projections and the reference tables promotion
-- needs to resolve identity. Read-only: promotion never edits a projection.
GRANT SELECT ON
    "budget_extraction_candidate_v1",
    "budget_verification_run_v1",
    "budget_review_decision_v1",
    "source_document",
    "program_element", "program_element_year", "program_element_budget_position",
    "program_element_project", "program_element_project_budget_position",
    "program_element_performer", "program_element_milestone",
    "program_element_milestone_schedule_period", "program_element_source",
    "procurement_budget_line", "procurement_budget_line_year",
    "procurement_distribution_line", "procurement_detail_fact",
    "om_sag", "om_sag_year", "om_detail_fact",
    "milcon_project", "milcon_project_year", "milcon_detail_fact",
    "non_rdte_budget_line_source_observation", "non_rdte_budget_line_relationship"
  TO capiro_pe_promoter;

-- The Phase 6 projection tables (phase6_audit_projection,
-- phase6_cycle_certification) are created by a SEPARATE migration chain at
-- prisma/phase6-projection/migrations, not by this one. Depending on the
-- deployment they may or may not be present in this database, so the grant is
-- conditional — an unconditional GRANT would break a fresh migration of the
-- main chain, which is exactly the kind of failure the Workstream D rehearsal
-- exists to catch.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['phase6_audit_projection', 'phase6_cycle_certification'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT ON public.%I TO capiro_pe_promoter', t);
    END IF;
  END LOOP;
END
$$;

-- Write the promotion ledger and canonical storage.
GRANT SELECT, INSERT, UPDATE ON
    "defense_budget_canonical_snapshot",
    "defense_budget_active_snapshot",
    "defense_budget_promotion_plan",
    "defense_budget_promotion_authorization",
    "defense_budget_promotion_run",
    "defense_budget_promotion_item",
    "defense_budget_promotion_activation",
    "defense_budget_promotion_outbox",
    "defense_budget_compatibility_projection_run",
    "defense_budget_rollback_record",
    "defense_budget_canonical_row",
    "defense_budget_promotion_audit"
  TO capiro_pe_promoter;

-- Manual overrides are READ by the promoter at plan time so a new snapshot
-- cannot silently overwrite one, and written by nobody in the promotion path.
-- Authoring and approving happen through the guarded admin surface on the
-- serve role; the promoter deciding what a human override says would defeat
-- the separation the overlay exists to create.
GRANT SELECT ON "defense_budget_manual_override" TO capiro_pe_promoter;

-- DELETE is granted nowhere: nothing in the promotion path deletes, and
-- rollback is a forward pointer transition. History cannot be removed by the
-- role that writes it.

COMMENT ON ROLE capiro_pe_promoter IS
  'Phase 7: the only database identity permitted to write canonical snapshot rows. Reads verified projections; holds no DDL, no role creation, no migration privilege, and no DELETE anywhere.';

-- ---------------------------------------------------------------------------
-- The general API serve role
-- ---------------------------------------------------------------------------
-- capiro_app must be able to READ the active snapshot and nothing more. The
-- REVOKE below is necessary because ALTER DEFAULT PRIVILEGES from migration
-- 20260502020000 has already granted it full DML on these tables as a side
-- effect of their creation.

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON
    "defense_budget_canonical_snapshot",
    "defense_budget_active_snapshot",
    "defense_budget_promotion_run",
    "defense_budget_promotion_item",
    "defense_budget_promotion_activation",
    "defense_budget_promotion_outbox",
    "defense_budget_compatibility_projection_run",
    "defense_budget_rollback_record",
    "defense_budget_canonical_row"
  FROM capiro_app;

-- The serve role may still file a promotion request and an authorization
-- record through the guarded admin surface (Phase 7 plan, promotion roles
-- rule 5), and must be able to write its own audit trail — but it can neither
-- execute a promotion nor touch a canonical row.
REVOKE UPDATE, DELETE, TRUNCATE ON
    "defense_budget_promotion_plan",
    "defense_budget_promotion_authorization"
  FROM capiro_app;
REVOKE DELETE, TRUNCATE ON "defense_budget_promotion_audit" FROM capiro_app;

-- The serve role files and approves overrides through the guarded admin
-- surface, so it keeps INSERT. It loses UPDATE and DELETE: an override is
-- amended by inserting a superseding version, never by editing the record of
-- what was previously approved.
REVOKE UPDATE, DELETE, TRUNCATE ON "defense_budget_manual_override" FROM capiro_app;

-- ===========================================================================
-- 7. Trigger-enforced boundaries
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 7a. Only the promoter may write canonical rows, and activated rows are frozen
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_canonical_row_boundary() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  owner_oid oid;
  snapshot_status text;
  target_snapshot uuid;
BEGIN
  -- Writer identity. The table owner is allowed because that is the migration
  -- and disposable-rehearsal identity; capiro_app is deliberately not a member
  -- of the owner role (scripts/sql/2026-07-19-rls-role-hardening.sql).
  SELECT c.relowner INTO owner_oid FROM pg_class c WHERE c.oid = TG_RELID;
  IF NOT (
    pg_has_role(current_user, 'capiro_pe_promoter', 'USAGE')
    OR pg_has_role(current_user, owner_oid, 'USAGE')
  ) THEN
    RAISE EXCEPTION
      'canonical rows may only be written by capiro_pe_promoter, not %', current_user
      USING ERRCODE = '42501';
  END IF;

  -- Immutability. A canonical row may only be touched while its snapshot is
  -- still staging and therefore invisible to product reads.
  target_snapshot := CASE WHEN TG_OP = 'INSERT' THEN NEW.snapshot_id ELSE OLD.snapshot_id END;
  SELECT s.status INTO snapshot_status
    FROM "defense_budget_canonical_snapshot" s WHERE s.id = target_snapshot;

  IF snapshot_status IS DISTINCT FROM 'STAGING' THEN
    RAISE EXCEPTION
      'snapshot % is %, not STAGING: canonical rows are immutable once a snapshot leaves staging (corrections arrive as a new snapshot)',
      target_snapshot, coalesce(snapshot_status, 'missing')
      USING ERRCODE = '0A000';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS defense_budget_canonical_row_boundary ON "defense_budget_canonical_row";
CREATE TRIGGER defense_budget_canonical_row_boundary
  BEFORE INSERT OR UPDATE OR DELETE ON "defense_budget_canonical_row"
  FOR EACH ROW EXECUTE FUNCTION enforce_canonical_row_boundary();

-- ---------------------------------------------------------------------------
-- 7b. Authorization is append-only apart from one consumption transition
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_promotion_authorization_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'promotion authorizations cannot be deleted'
      USING ERRCODE = '0A000';
  END IF;

  -- A used authorization is spent forever.
  IF OLD.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'authorization % was already consumed at % and is one-use',
      OLD.authorization_id, OLD.consumed_at
      USING ERRCODE = '0A000';
  END IF;

  -- The only legal update is recording consumption. Everything else about the
  -- authorization — scope, hashes, expiry, authorizer, segregation — is frozen,
  -- so an authorizer cannot widen a grant after issuing it.
  IF (to_jsonb(NEW) - 'consumed_at' - 'consumed_by_run_id')
     <> (to_jsonb(OLD) - 'consumed_at' - 'consumed_by_run_id') THEN
    RAISE EXCEPTION 'promotion authorizations are immutable; only consumption may be recorded'
      USING ERRCODE = '0A000';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS defense_budget_promotion_authorization_append_only
  ON "defense_budget_promotion_authorization";
CREATE TRIGGER defense_budget_promotion_authorization_append_only
  BEFORE UPDATE OR DELETE ON "defense_budget_promotion_authorization"
  FOR EACH ROW EXECUTE FUNCTION enforce_promotion_authorization_append_only();

-- ---------------------------------------------------------------------------
-- 7c. Plans, activations, rollbacks, and the audit trail are append-only
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_promotion_ledger_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only: % rows cannot be modified or deleted', TG_TABLE_NAME
    USING ERRCODE = '0A000';
END;
$$;

DROP TRIGGER IF EXISTS defense_budget_promotion_plan_append_only ON "defense_budget_promotion_plan";
CREATE TRIGGER defense_budget_promotion_plan_append_only
  BEFORE UPDATE OR DELETE ON "defense_budget_promotion_plan"
  FOR EACH ROW EXECUTE FUNCTION enforce_promotion_ledger_append_only();

DROP TRIGGER IF EXISTS defense_budget_promotion_activation_append_only
  ON "defense_budget_promotion_activation";
CREATE TRIGGER defense_budget_promotion_activation_append_only
  BEFORE UPDATE OR DELETE ON "defense_budget_promotion_activation"
  FOR EACH ROW EXECUTE FUNCTION enforce_promotion_ledger_append_only();

DROP TRIGGER IF EXISTS defense_budget_rollback_record_append_only ON "defense_budget_rollback_record";
CREATE TRIGGER defense_budget_rollback_record_append_only
  BEFORE UPDATE OR DELETE ON "defense_budget_rollback_record"
  FOR EACH ROW EXECUTE FUNCTION enforce_promotion_ledger_append_only();

DROP TRIGGER IF EXISTS defense_budget_promotion_audit_append_only ON "defense_budget_promotion_audit";
CREATE TRIGGER defense_budget_promotion_audit_append_only
  BEFORE UPDATE OR DELETE ON "defense_budget_promotion_audit"
  FOR EACH ROW EXECUTE FUNCTION enforce_promotion_ledger_append_only();

-- Workstream K. Revocation is an insert of a superseding version, not an
-- UPDATE of the row that was approved, so the override table is append-only on
-- exactly the same terms as the rest of the ledger — for every role, including
-- the table owner.
DROP TRIGGER IF EXISTS defense_budget_manual_override_append_only
  ON "defense_budget_manual_override";
CREATE TRIGGER defense_budget_manual_override_append_only
  BEFORE UPDATE OR DELETE ON "defense_budget_manual_override"
  FOR EACH ROW EXECUTE FUNCTION enforce_promotion_ledger_append_only();

-- Snapshots are never deleted. Status may advance; the identity may not change.
CREATE OR REPLACE FUNCTION enforce_canonical_snapshot_immutable_identity() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'canonical snapshots are never deleted; rollback is a forward pointer transition'
      USING ERRCODE = '0A000';
  END IF;
  IF NEW.snapshot_key <> OLD.snapshot_key
     OR NEW.cycle_id <> OLD.cycle_id
     OR NEW.fiscal_year <> OLD.fiscal_year
     OR NEW.domain <> OLD.domain
     OR NEW.environment <> OLD.environment THEN
    RAISE EXCEPTION 'snapshot identity is immutable' USING ERRCODE = '0A000';
  END IF;
  -- A hash, once published, pins the content of the snapshot.
  IF OLD.snapshot_hash IS NOT NULL AND NEW.snapshot_hash IS DISTINCT FROM OLD.snapshot_hash THEN
    RAISE EXCEPTION 'snapshot hash is immutable once set' USING ERRCODE = '0A000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS defense_budget_canonical_snapshot_immutable
  ON "defense_budget_canonical_snapshot";
CREATE TRIGGER defense_budget_canonical_snapshot_immutable
  BEFORE UPDATE OR DELETE ON "defense_budget_canonical_snapshot"
  FOR EACH ROW EXECUTE FUNCTION enforce_canonical_snapshot_immutable_identity();

-- ---------------------------------------------------------------------------
-- 7d. Activation preconditions
-- ---------------------------------------------------------------------------
-- The activation pointer may only move to a snapshot that is READY or ACTIVE
-- and whose required scopes are all complete, and only from the snapshot the
-- activation record says it expected. These are the conditions Phase 7 requires
-- to be enforced by the database rather than by a comment.
CREATE OR REPLACE FUNCTION enforce_active_snapshot_preconditions() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  snap record;
  missing_scopes text;
  activation record;
BEGIN
  SELECT * INTO snap FROM "defense_budget_canonical_snapshot" WHERE id = NEW.snapshot_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'snapshot % does not exist', NEW.snapshot_id USING ERRCODE = '23503';
  END IF;

  IF snap.status NOT IN ('READY', 'ACTIVE') THEN
    RAISE EXCEPTION 'snapshot % is % and cannot be activated (must be READY or ACTIVE)',
      snap.id, snap.status USING ERRCODE = '0A000';
  END IF;

  -- Every required scope must appear in the completed set.
  SELECT string_agg(value, ', ') INTO missing_scopes
    FROM jsonb_array_elements_text(snap.required_scopes) AS r(value)
    WHERE NOT (snap.completed_scopes ? r.value);
  IF missing_scopes IS NOT NULL THEN
    RAISE EXCEPTION 'snapshot % cannot be activated with incomplete scopes: %',
      snap.id, missing_scopes USING ERRCODE = '0A000';
  END IF;

  -- The activation record must exist and must agree about what it superseded.
  SELECT * INTO activation FROM "defense_budget_promotion_activation" WHERE id = NEW.activation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'activation % does not exist', NEW.activation_id USING ERRCODE = '23503';
  END IF;
  IF activation.new_snapshot_id <> NEW.snapshot_id THEN
    RAISE EXCEPTION 'activation % activates snapshot %, not %',
      activation.id, activation.new_snapshot_id, NEW.snapshot_id USING ERRCODE = '0A000';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF activation.previous_snapshot_id IS DISTINCT FROM OLD.snapshot_id THEN
      RAISE EXCEPTION
        'activation % expected to supersede snapshot %, but % is active (active-snapshot drift)',
        activation.id, coalesce(activation.previous_snapshot_id::text, '(none)'), OLD.snapshot_id
        USING ERRCODE = '40001';
    END IF;
  ELSE
    IF activation.previous_snapshot_id IS NOT NULL THEN
      RAISE EXCEPTION
        'activation % expected to supersede snapshot %, but nothing is active yet',
        activation.id, activation.previous_snapshot_id USING ERRCODE = '40001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS defense_budget_active_snapshot_preconditions ON "defense_budget_active_snapshot";
CREATE TRIGGER defense_budget_active_snapshot_preconditions
  BEFORE INSERT OR UPDATE ON "defense_budget_active_snapshot"
  FOR EACH ROW EXECUTE FUNCTION enforce_active_snapshot_preconditions();

-- The pointer is never deleted; it is moved.
CREATE OR REPLACE FUNCTION enforce_active_snapshot_no_delete() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'the active-snapshot pointer is moved, never deleted' USING ERRCODE = '0A000';
END;
$$;

DROP TRIGGER IF EXISTS defense_budget_active_snapshot_no_delete ON "defense_budget_active_snapshot";
CREATE TRIGGER defense_budget_active_snapshot_no_delete
  BEFORE DELETE ON "defense_budget_active_snapshot"
  FOR EACH ROW EXECUTE FUNCTION enforce_active_snapshot_no_delete();

-- ---------------------------------------------------------------------------
-- 7e. A run must match the authorization it claims
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_promotion_run_authorization_match() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  auth record;
  plan record;
BEGIN
  SELECT * INTO auth FROM "defense_budget_promotion_authorization"
    WHERE authorization_id = NEW.authorization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'authorization % does not exist', NEW.authorization_id USING ERRCODE = '23503';
  END IF;

  IF auth.plan_id <> NEW.plan_id THEN
    RAISE EXCEPTION 'authorization % is for plan %, not %',
      auth.authorization_id, auth.plan_id, NEW.plan_id USING ERRCODE = '0A000';
  END IF;
  IF auth.plan_hash <> NEW.plan_hash THEN
    RAISE EXCEPTION 'authorization % was issued against a different plan hash',
      auth.authorization_id USING ERRCODE = '0A000';
  END IF;
  IF auth.expected_active_snapshot_id IS DISTINCT FROM NEW.expected_active_snapshot_id THEN
    RAISE EXCEPTION 'authorization % expected a different active snapshot',
      auth.authorization_id USING ERRCODE = '0A000';
  END IF;

  SELECT * INTO plan FROM "defense_budget_promotion_plan" WHERE plan_id = NEW.plan_id;
  IF plan.blocked_count > 0 THEN
    RAISE EXCEPTION 'plan % has % blocked item(s) and cannot be executed',
      plan.plan_id, plan.blocked_count USING ERRCODE = '0A000';
  END IF;
  IF plan.plan_hash <> NEW.plan_hash THEN
    RAISE EXCEPTION 'run plan hash does not match the stored plan' USING ERRCODE = '0A000';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS defense_budget_promotion_run_authorization_match ON "defense_budget_promotion_run";
CREATE TRIGGER defense_budget_promotion_run_authorization_match
  BEFORE INSERT OR UPDATE ON "defense_budget_promotion_run"
  FOR EACH ROW EXECUTE FUNCTION enforce_promotion_run_authorization_match();

-- ---------------------------------------------------------------------------
-- 7f. Expired authorizations fail closed at redemption
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_authorization_not_expired_on_activation() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  auth record;
BEGIN
  SELECT * INTO auth FROM "defense_budget_promotion_authorization"
    WHERE authorization_id = NEW.authorization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'authorization % does not exist', NEW.authorization_id USING ERRCODE = '23503';
  END IF;
  IF auth.expires_at <= now() THEN
    RAISE EXCEPTION 'authorization % expired at % and cannot be activated',
      auth.authorization_id, auth.expires_at USING ERRCODE = '0A000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS defense_budget_activation_authorization_valid
  ON "defense_budget_promotion_activation";
CREATE TRIGGER defense_budget_activation_authorization_valid
  BEFORE INSERT ON "defense_budget_promotion_activation"
  FOR EACH ROW EXECUTE FUNCTION enforce_authorization_not_expired_on_activation();
