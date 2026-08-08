-- Phase 7 Workstream L — draining the promotion outbox, pausing it, and the
-- generic snapshot-to-snapshot delta record.
--
-- Separate from 20260822010000 for the same reason Workstream K's queue link
-- was: that migration is purely additive and an architecture test asserts it
-- contains no ALTER TABLE. This one adds a column to a table that migration
-- created, so it belongs here rather than there.
--
-- Three things arrive together because the drainer needs all three to be
-- honest:
--
--   1. `last_attempted_at` on the outbox. The Workstream L drain policy backs a
--      failed row off exponentially, and `isDrainEligibleV1` needs the instant
--      of the last attempt to decide eligibility. Without it the policy has a
--      backoff that nothing can measure, so every failed row would be retried
--      on the next pass regardless of how recently it failed.
--
--   2. A pause state per (domain, environment). `rollback()` in Workstream E
--      calls `pauseSideEffectDrain` before it moves the active pointer,
--      precisely so a batch cannot publish the outgoing snapshot's changes
--      after that snapshot stops being active. Until this table exists, that
--      call is an honest no-op and the policy honours a pause nothing can set.
--
--   3. `defense_budget_canonical_delta`. The generic snapshot-to-snapshot
--      delta record, primary for every family — RDT&E, procurement, O&M,
--      MILCON, congressional stages, actions, project funding, quantities and
--      unit cost. `program_element_delta` remains as a compatibility read model
--      for the PE surfaces that already query it; it is no longer where a
--      canonical change is first recorded.
--
-- ---------------------------------------------------------------------------
-- Why the delta table repeats the stage-to-field authority check
-- ---------------------------------------------------------------------------
-- The Phase 7 F–J review found a P1 in which a request-side candidate could
-- assert a congressional mark on a per-FY row with no stage and no authority.
-- The damage that finding described was not the canonical row itself: it was
-- that "a wrong funding field on a *_year row would have travelled through L's
-- delta engine into a client alert asserting a congressional action that never
-- happened". This table is that engine's output. Repeating the check here means
-- the last structure before a client-visible alert refuses the same defect,
-- even if it were reintroduced upstream.

-- ===========================================================================
-- 1. Attempt bookkeeping on the outbox
-- ===========================================================================

ALTER TABLE "defense_budget_promotion_outbox"
  ADD COLUMN "last_attempted_at" TIMESTAMPTZ(6);

COMMENT ON COLUMN "defense_budget_promotion_outbox"."last_attempted_at" IS
  'Phase 7 Workstream L: when this row was last claimed by a drainer. NULL means never attempted, which is always eligible; otherwise the drain policy''s exponential backoff is measured from here.';

-- Supports the eligibility predicate the drainer claims with. Partial, because
-- DONE and POISON rows are the ones that accumulate and neither is ever
-- claimable again.
CREATE INDEX "defense_budget_promotion_outbox_eligibility_idx"
    ON "defense_budget_promotion_outbox" ("status", "attempts", "last_attempted_at")
    WHERE "status" IN ('PENDING', 'FAILED');

-- ===========================================================================
-- 2. Drain pause state
-- ===========================================================================

CREATE TABLE "defense_budget_side_effect_drain_pause" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "domain" VARCHAR(40) NOT NULL,
    "environment" VARCHAR(24) NOT NULL,
    "paused" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT NOT NULL,
    "paused_by" TEXT NOT NULL,
    "paused_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "resumed_by" TEXT,
    "resumed_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "defense_budget_side_effect_drain_pause_pkey" PRIMARY KEY ("id"),
    -- One state per domain and environment. The drainer reads exactly one row
    -- to decide whether to claim, so two rows would mean two answers.
    CONSTRAINT "defense_budget_side_effect_drain_pause_scope_unique"
        UNIQUE ("domain", "environment"),
    CONSTRAINT "defense_budget_side_effect_drain_pause_reason_check"
        CHECK (btrim("reason") <> ''),
    -- A resumed row records who resumed it and when; a paused row records
    -- neither. This is what keeps "paused" from drifting away from the audit
    -- trail that explains it.
    CONSTRAINT "defense_budget_side_effect_drain_pause_resume_check"
        CHECK (("paused" = true AND "resumed_at" IS NULL AND "resumed_by" IS NULL)
               OR ("paused" = false AND "resumed_at" IS NOT NULL AND "resumed_by" IS NOT NULL))
);

COMMENT ON TABLE "defense_budget_side_effect_drain_pause" IS
  'Phase 7 Workstream L: whether the promotion-outbox drainer may claim work for a domain and environment. Set by rollback before the active pointer moves, so a drain in flight cannot announce a value that has stopped being true.';

-- ===========================================================================
-- 3. Generic snapshot-to-snapshot deltas
-- ===========================================================================

CREATE TABLE "defense_budget_canonical_delta" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    -- Deterministic, so a replayed drain re-derives the same key and the unique
    -- constraint absorbs the duplicate instead of double-counting a change.
    "delta_key" TEXT NOT NULL,
    "activation_id" UUID NOT NULL,
    -- Exactly one delta per drained outbox row. A second delta for the same row
    -- would mean the same change was published twice under different numbers.
    "outbox_id" UUID NOT NULL,
    "old_snapshot_id" UUID,
    "new_snapshot_id" UUID NOT NULL,

    "canonical_entity" VARCHAR(80) NOT NULL,
    "canonical_natural_key" TEXT NOT NULL,
    "family" VARCHAR(24) NOT NULL,
    "fiscal_year" INTEGER,
    "funding_field" VARCHAR(32),
    "stage" VARCHAR(40),

    "delta_kind" VARCHAR(32) NOT NULL,
    -- Which value axes moved: money, quantity, unit_cost, text, date,
    -- attributes. An array rather than a single field because one canonical row
    -- can move on several axes at once and collapsing them would lose which.
    "changed_axes" JSONB NOT NULL,

    -- Both sides of the change, exact. NUMERIC and the printed original string,
    -- never float, on both the old and the new side.
    "old_money_original_value" TEXT,
    "old_money_value_millions" NUMERIC(24, 9),
    "new_money_original_value" TEXT,
    "new_money_value_millions" NUMERIC(24, 9),
    -- new - old, computed by exact decimal arithmetic and stored exactly. NULL
    -- when either side is absent: a new start has no difference, it has a value.
    "money_delta_millions" NUMERIC(24, 9),

    "old_quantity" NUMERIC(24, 9),
    "new_quantity" NUMERIC(24, 9),
    "old_unit_cost_dollars" NUMERIC(24, 9),
    "new_unit_cost_dollars" NUMERIC(24, 9),

    "change_classification" VARCHAR(40) NOT NULL,
    "suppress_alert" BOOLEAN NOT NULL,
    "alert_eligible" BOOLEAN NOT NULL DEFAULT false,
    -- A heuristic 0..1 ranking signal, not money. Stored NUMERIC anyway so the
    -- canonical path contains no approximate numeric column at all.
    "materiality_score" NUMERIC(6, 5) NOT NULL DEFAULT 0,
    "materiality_factors" JSONB NOT NULL DEFAULT '{}',
    "severity" VARCHAR(12) NOT NULL DEFAULT 'info',

    "source_lineage" JSONB NOT NULL DEFAULT '{}',
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "defense_budget_canonical_delta_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "defense_budget_canonical_delta_key_unique" UNIQUE ("delta_key"),
    CONSTRAINT "defense_budget_canonical_delta_outbox_unique" UNIQUE ("outbox_id"),

    CONSTRAINT "defense_budget_canonical_delta_activation_fkey"
        FOREIGN KEY ("activation_id") REFERENCES "defense_budget_promotion_activation"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "defense_budget_canonical_delta_outbox_fkey"
        FOREIGN KEY ("outbox_id") REFERENCES "defense_budget_promotion_outbox"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "defense_budget_canonical_delta_old_snapshot_fkey"
        FOREIGN KEY ("old_snapshot_id") REFERENCES "defense_budget_canonical_snapshot"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "defense_budget_canonical_delta_new_snapshot_fkey"
        FOREIGN KEY ("new_snapshot_id") REFERENCES "defense_budget_canonical_snapshot"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,

    CONSTRAINT "defense_budget_canonical_delta_kind_check"
        CHECK ("delta_kind" IN ('new_start', 'termination', 'increase', 'decrease',
                                'quantity_change', 'unit_cost_change',
                                'nonfinancial_change', 'identity_change')),

    CONSTRAINT "defense_budget_canonical_delta_classification_check"
        CHECK ("change_classification" IN ('initial_hydration', 'material_change', 'correction',
                                           'rollback', 'unchanged', 'identity_change')),

    CONSTRAINT "defense_budget_canonical_delta_severity_check"
        CHECK ("severity" IN ('info', 'notable', 'critical')),

    CONSTRAINT "defense_budget_canonical_delta_score_check"
        CHECK ("materiality_score" >= 0 AND "materiality_score" <= 1),

    -- The suppression rule, repeated at the last structure before a client sees
    -- anything. Hydration, corrections, rollbacks, and unchanged rows can never
    -- be alert-eligible, and a suppressed row can never be alert-eligible
    -- whatever its classification.
    CONSTRAINT "defense_budget_canonical_delta_suppression_check"
        CHECK ("change_classification" NOT IN ('initial_hydration', 'correction', 'rollback', 'unchanged')
               OR "alert_eligible" = false),
    CONSTRAINT "defense_budget_canonical_delta_alert_consistency_check"
        CHECK ("alert_eligible" = false OR "suppress_alert" = false),

    -- Money is a pair on each side: a normalized amount with no printed
    -- original is how a rounded value would hide.
    CONSTRAINT "defense_budget_canonical_delta_old_money_check"
        CHECK (num_nonnulls("old_money_original_value", "old_money_value_millions") IN (0, 2)),
    CONSTRAINT "defense_budget_canonical_delta_new_money_check"
        CHECK (num_nonnulls("new_money_original_value", "new_money_value_millions") IN (0, 2)),
    CONSTRAINT "defense_budget_canonical_delta_difference_check"
        CHECK ("money_delta_millions" IS NULL
               OR ("old_money_value_millions" IS NOT NULL AND "new_money_value_millions" IS NOT NULL)),

    CONSTRAINT "defense_budget_canonical_delta_axes_check"
        CHECK (jsonb_typeof("changed_axes") = 'array' AND jsonb_array_length("changed_axes") > 0),

    CONSTRAINT "defense_budget_canonical_delta_funding_field_check"
        CHECK ("funding_field" IS NULL OR "funding_field" IN
               ('request', 'hascMark', 'sascMark', 'hacDMark', 'sacDMark',
                'ndaaConference', 'conference', 'enacted', 'reprogrammed', 'executed')),

    CONSTRAINT "defense_budget_canonical_delta_stage_check"
        CHECK ("stage" IS NULL OR "stage" IN
               ('hasc', 'sasc', 'ndaa_conference', 'hac_d', 'sac_d',
                'appropriations_conference', 'public_law', 'continuing_resolution',
                'reprogramming', 'execution')),

    -- The database's copy of STAGE_AUTHORITY_FIELD, identical to the one on
    -- defense_budget_canonical_row. A delta asserting a congressional mark must
    -- name the authority that published it; NULL is not an escape hatch.
    CONSTRAINT "defense_budget_canonical_delta_stage_field_check"
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
        )))
);

CREATE INDEX "defense_budget_canonical_delta_snapshot_idx"
    ON "defense_budget_canonical_delta" ("new_snapshot_id", "family", "fiscal_year");
CREATE INDEX "defense_budget_canonical_delta_identity_idx"
    ON "defense_budget_canonical_delta" ("canonical_entity", "canonical_natural_key");
CREATE INDEX "defense_budget_canonical_delta_activation_idx"
    ON "defense_budget_canonical_delta" ("activation_id");
-- The fan-out reads only the alert-eligible tail, which is a small fraction of
-- a hydration snapshot's several hundred thousand rows.
CREATE INDEX "defense_budget_canonical_delta_alertable_idx"
    ON "defense_budget_canonical_delta" ("new_snapshot_id", "materiality_score")
    WHERE "alert_eligible" = true;

COMMENT ON TABLE "defense_budget_canonical_delta" IS
  'Phase 7 Workstream L: the primary record of what changed between two canonical snapshots, generic across every native line kind. program_element_delta remains a compatibility read model for existing PE surfaces and is no longer where a canonical change is first recorded.';

-- ===========================================================================
-- 4. Grants
-- ===========================================================================
--
-- The drainer runs as capiro_pe_promoter: it is the only role holding UPDATE on
-- the outbox, which is what claiming a row requires. It reads canonical rows to
-- resolve both sides of a change and writes the delta.

GRANT SELECT, INSERT, UPDATE ON "defense_budget_side_effect_drain_pause" TO capiro_pe_promoter;
-- INSERT only on the delta: a computed delta is never revised. The append-only
-- trigger below enforces that for every role including the table owner; the
-- absent UPDATE grant is the cheaper first line.
GRANT SELECT, INSERT ON "defense_budget_canonical_delta" TO capiro_pe_promoter;

-- The serve role reads deltas for the product surfaces and reads the pause
-- state to report drain status. It writes neither. ALTER DEFAULT PRIVILEGES
-- from migration 20260502020000 has already granted it full DML on both tables
-- as a side effect of their creation, so this revoke is load-bearing.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON
    "defense_budget_side_effect_drain_pause",
    "defense_budget_canonical_delta"
  FROM capiro_app;

-- DELETE is granted nowhere here either. A delta is history.

-- ===========================================================================
-- 5. Append-only enforcement
-- ===========================================================================
--
-- Reuses enforce_promotion_ledger_append_only from 20260822010000. A delta is
-- computed once from two immutable snapshots; if it is wrong, the answer is a
-- new snapshot, exactly as it is for a canonical row. Per-tenant materiality is
-- re-scored at read time and deliberately never stored, so there is no
-- legitimate reason to update one of these rows.

DROP TRIGGER IF EXISTS defense_budget_canonical_delta_append_only
  ON "defense_budget_canonical_delta";
CREATE TRIGGER defense_budget_canonical_delta_append_only
  BEFORE UPDATE OR DELETE ON "defense_budget_canonical_delta"
  FOR EACH ROW EXECUTE FUNCTION enforce_promotion_ledger_append_only();
