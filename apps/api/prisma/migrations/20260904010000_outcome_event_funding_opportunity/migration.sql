-- Funding Opportunities P36 — outcome capture and governed learning candidate.
--
-- WHAT THIS IS
-- -------------------------------------------------------------------
-- Widens the EXISTING `outcome_event` table (G3, 20260713040000) rather than
-- creating a new one. The plan's own instruction is explicit: "Write an
-- OutcomeEvent if the existing model fits; add only missing fields/migration."
-- It fits. `outcome_event` is already tenant-scoped, RLS-forced, append-only,
-- and its own `evidence_jsonb` comment says its shape "evolves without
-- migration" — exactly what a reason-codes taxonomy, a vehicle/partner outcome
-- and a source award link need. The only thing missing is admission into the
-- two closed vocabularies this phase actually needs.
--
-- THE VOCABULARY CHECK IS WIDENED, NEVER NARROWED — same rule P13 used for
-- `client_funding_opportunity_source_chk`. `kind` gains `pursuit_won`,
-- `pursuit_lost`, `pursuit_passed` — namespaced with a `pursuit_` prefix so a
-- procurement outcome can never collide with or be misread as one of the
-- table's existing advocacy-outcome kinds (`response_received`,
-- `commitment_secured`, etc.), which describe a different domain entirely.
-- `source_type` gains `funding_opportunity`.
--
-- REOPENING IS AN INSERT, NOT AN UPDATE, AND THAT IS THE WHOLE MECHANISM
-- -------------------------------------------------------------------
-- The plan's acceptance line — "reopening a lost/passed pursuit preserves
-- prior outcome version" — falls out of the table's own append-only design
-- for free. There is no UPDATE path here, deliberately: a second outcome
-- recorded for the same (tenant, client, source_type, source_id) is a NEW
-- row, and the read side (funding-opportunity-outcome.service.ts) resolves
-- "current" as the latest by `observed_at`. The first row is never touched.
--
-- NO NEW COLUMN, NO NEW TABLE. `observed_at` already carries the outcome
-- date, `notes` already carries the free-text note, and `evidence_jsonb`
-- carries the reason codes, the vehicle/partner outcome, and the source
-- award link — required at the SERVICE layer (a shape a JSONB CHECK cannot
-- usefully express) and proven there by tests, matching how this table's own
-- comment already describes `evidence_jsonb` as schema-free by design.
--
-- RETRY-SAFE. `ALTER TABLE ... ADD CONSTRAINT` has no `IF NOT EXISTS` form in
-- Postgres, so the DROP-then-ADD is wrapped in a guard on `pg_constraint`,
-- matching every other widened-CHECK migration in this program.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'outcome_event_kind_chk') THEN
    ALTER TABLE "outcome_event" DROP CONSTRAINT "outcome_event_kind_chk";
  END IF;
  ALTER TABLE "outcome_event" ADD CONSTRAINT "outcome_event_kind_chk" CHECK ("kind" IN (
    'response_received', 'meeting_scheduled', 'meeting_held',
    'language_included', 'funding_changed', 'filing_completed',
    'commitment_secured', 'no_action',
    'pursuit_won', 'pursuit_lost', 'pursuit_passed'
  ));
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'outcome_event_source_type_chk') THEN
    ALTER TABLE "outcome_event" DROP CONSTRAINT "outcome_event_source_type_chk";
  END IF;
  ALTER TABLE "outcome_event" ADD CONSTRAINT "outcome_event_source_type_chk" CHECK ("source_type" IN (
    'outreach', 'meeting', 'artifact', 'campaign', 'submission', 'manual',
    'funding_opportunity'
  ));
END $$;
