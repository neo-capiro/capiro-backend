-- Phase 8 Session 11 — governed review-resolution audit.
--
-- Discovered by the Session 11 disposable-database rehearsal, not assumed:
-- `capiro_defense_job` has no grant on the general-purpose `audit_logs`
-- table (only `capiro_defense_serve` does, from an earlier, unrelated
-- migration serving the older PE-Budget-Phase-7 admin flows). Session 11's
-- one write action — resolving a `review_required` expected source — runs
-- exclusively under job-role credentials
-- (`apps/defense-api/scripts/run-review-resolution.mjs`), so it needs its
-- own narrow audit table, on the same append-only precedent as Session 9's
-- `defense_provider_invocation`: job gets SELECT + INSERT and nothing else,
-- so a resolution is recorded but never edited or erased.
--
-- What it deliberately does NOT hold: no amount, no credential, no secret.
-- The row is the human decision (which state, whose note, when) plus the
-- state it moved FROM — the frozen Session 7
-- `LifecycleStore.setExpectedSourceState` remains the sole writer of the
-- `defense_budget_expected_source` row itself; this table is a record of
-- that call, not an alternate path to it.

CREATE TABLE "defense_budget_review_resolution" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "expected_source_id" UUID NOT NULL,
  "previous_expected_state" TEXT NOT NULL,
  "decision" TEXT NOT NULL,
  "review_reason_before" TEXT,
  "note" TEXT NOT NULL,
  "actor_user_id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "resolved_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "dbrr_previous_state_chk" CHECK (
    "previous_expected_state" = 'review_required'
  ),
  CONSTRAINT "dbrr_decision_chk" CHECK (
    "decision" IN ('expected', 'not_filed', 'published', 'withdrawn', 'unavailable')
  ),
  CONSTRAINT "dbrr_note_chk" CHECK (length(btrim("note")) > 0),
  CONSTRAINT "dbrr_expected_source_fk"
    FOREIGN KEY ("expected_source_id") REFERENCES "defense_budget_expected_source"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "dbrr_tenant_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE INDEX "dbrr_expected_source_idx" ON "defense_budget_review_resolution" ("expected_source_id", "resolved_at" DESC);
CREATE INDEX "dbrr_tenant_idx" ON "defense_budget_review_resolution" ("tenant_id", "resolved_at" DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- Least-privilege grants: append-only, job-role-only writer.
--
-- `capiro_defense_serve` gets SELECT only — consistent with every other
-- table in this domain, and leaves room for a future read surface to show
-- resolution history without ever being able to write one. Neither role
-- gets UPDATE or DELETE: a resolution record, once written, is permanent.
-- ───────────────────────────────────────────────────────────────────────────
REVOKE ALL ON TABLE "defense_budget_review_resolution" FROM PUBLIC;

GRANT SELECT ON TABLE "defense_budget_review_resolution" TO "capiro_defense_serve";
GRANT SELECT, INSERT ON TABLE "defense_budget_review_resolution" TO "capiro_defense_job";
