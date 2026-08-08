-- Phase 7 Gap 3 closeout — persist promotion eligibility.
--
-- `DefenseBudgetPromotionAuthorizationServiceV1.issue()` (promotion-authorization-
-- service-v1.ts) has always required `PromotionAuthorizationRepositoryV1.loadPlan`
-- to return the *whole* eligibility record, not its hash — it recomputes
-- `promotionEligibilityHashV1(plan.eligibility)` to detect storage tampering, and
-- derives segregation-of-duties evidence from the eligibility's own candidate
-- bindings so an authorizer cannot understate their own involvement. There was no
-- table to store that record: `defense_budget_promotion_plan.eligibility_hash` is
-- a bare CHAR(64) with nothing behind it. This is that table.
--
-- Append-only, like every other promotion ledger table: an eligibility
-- evaluation is a fact about what was true when eligibility was checked, not a
-- row that gets corrected in place. A changed set of facts is a *new*
-- evaluation with a new hash, exactly like a changed plan requires a new plan
-- ID (Phase 7 plan, promotion lifecycle rules).
--
-- The foreign key is the acceptance criterion named in
-- docs/defense-budget/PHASE-7-ARCHITECTURE-GAPS.md Gap 3: "a plan cannot
-- reference an eligibility that was never recorded." Safe to add against the
-- existing `defense_budget_promotion_plan.eligibility_hash` column because
-- nothing has ever promoted against a real database — every existing row in
-- that table, if any exist at all, comes from a disposable rehearsal that
-- starts from an empty database.

CREATE TABLE "defense_budget_promotion_eligibility" (
    "id"                      UUID NOT NULL DEFAULT gen_random_uuid(),
    "eligibility_id"          TEXT NOT NULL,
    "eligibility_hash"        CHAR(64) NOT NULL,
    "cycle_id"                TEXT NOT NULL,
    "mapping_registry_version" TEXT NOT NULL,
    "mapping_registry_hash"   CHAR(64) NOT NULL,
    "scope"                   JSONB NOT NULL,
    "scope_hash"              CHAR(64) NOT NULL,
    "open_conflict_count"     INTEGER NOT NULL,
    "unsupported_item_count"  INTEGER NOT NULL,
    "document"                JSONB NOT NULL,
    "generated_at"            TIMESTAMPTZ(6) NOT NULL,
    "created_at"              TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "defense_budget_promotion_eligibility_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "defense_budget_promotion_eligibility_hash_unique"
  ON "defense_budget_promotion_eligibility"("eligibility_hash");

-- `eligibility_id` is caller-assigned (like `plan_id`) and, per the eligibility
-- contract's own invariant, one eligibility ID never carries two different
-- hashes — a changed set of facts is a new ID, not a silent rewrite. Same
-- identity/hash pairing shape as `defense_budget_promotion_plan_identity_unique`.
CREATE UNIQUE INDEX "defense_budget_promotion_eligibility_identity_unique"
  ON "defense_budget_promotion_eligibility"("eligibility_id", "eligibility_hash");

CREATE INDEX "defense_budget_promotion_eligibility_cycle_idx"
  ON "defense_budget_promotion_eligibility"("cycle_id");

COMMENT ON TABLE "defense_budget_promotion_eligibility" IS
  'Phase 7 Workstream A / Gap 3 closeout. Append-only record of an eligibility evaluation, keyed by its content hash. A promotion plan may not reference an eligibility hash absent from this table.';

-- ---------------------------------------------------------------------------
-- The foreign key: a plan cannot reference an eligibility that was never
-- recorded. References the hash, not a surrogate id, so the constraint reads
-- exactly as the invariant it enforces.
-- ---------------------------------------------------------------------------
ALTER TABLE "defense_budget_promotion_plan"
  ADD CONSTRAINT "defense_budget_promotion_plan_eligibility_fkey"
  FOREIGN KEY ("eligibility_hash")
  REFERENCES "defense_budget_promotion_eligibility"("eligibility_hash")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- Append-only. Reuses the same generic ledger-append-only function every other
-- promotion ledger table already uses (migration 20260822010000) — one
-- exception function, applied per table, rather than a new one for a table
-- with the identical rule.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS defense_budget_promotion_eligibility_append_only
  ON "defense_budget_promotion_eligibility";
CREATE TRIGGER defense_budget_promotion_eligibility_append_only
  BEFORE UPDATE OR DELETE ON "defense_budget_promotion_eligibility"
  FOR EACH ROW EXECUTE FUNCTION enforce_promotion_ledger_append_only();

-- ---------------------------------------------------------------------------
-- Grants. Same treatment as defense_budget_promotion_plan /
-- _authorization: the serve role evaluates and files eligibility through the
-- guarded admin surface (capiro_app), so it keeps INSERT and SELECT; UPDATE/
-- DELETE/TRUNCATE are revoked outright (the trigger above would refuse them
-- anyway — this is the second, independent enforcement layer, not the only
-- one). capiro_pe_promoter needs no grant here at all: Gap 3's own analysis
-- confirms execute/rollback only ever compare `eligibility_hash` as a string
-- already present on the plan row they load, never the full record.
-- ---------------------------------------------------------------------------
REVOKE UPDATE, DELETE, TRUNCATE ON "defense_budget_promotion_eligibility" FROM capiro_app;
