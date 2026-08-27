-- Advocacy History follow-on: deterministic regulatory outcome correlation.
--
-- Closes the gap `suggestFederalRegisterCorrelations` (PR #1310) documented
-- explicitly as deferred: "a later final agency action becoming an Outcome
-- is a distinct, separately-confirmed step (product spec §8), not inferred
-- here." This migration only widens the two closed vocabularies
-- `outcome_event` already has for exactly that step — same mechanism P36
-- (20260904010000) used to add the `pursuit_*`/`funding_opportunity`
-- values, never narrowed, no new column, no new table.
--
-- `kind` gains `regulatory_action_published` — a Federal Register proposed
-- rule / notice / final rule observed on a docket the client is already
-- attributably advocating on (matched by exact docket id, never by name or
-- text). `source_type` gains `regulatory_document`, pointing `source_id` at
-- the Federal Register `document_number`. `evidence_jsonb` carries
-- `{ docketId, documentNumber, documentType, agencyNames, publicationDate,
-- matchedOn: 'docket_id' }` — no new column needed, matching this table's
-- own "evolves without migration" evidence-shape comment.
--
-- `client_profile_fill_finding.kind` gains `regulatory_outcome` (parallel to
-- `advocacy_outcome`) so the same pending -> accept -> apply review lifecycle
-- applies here unchanged. `client_profile_fill_finding_source_check` gains
-- `federal_register` — `gatherFederalRegisterBackfill` has read Federal
-- Register correlations since PR #1310 but never written a finding from
-- them (20271231080000's own history shows what happens when a source
-- starts writing without this constraint keeping up: 23514 in production).
-- RETRY-SAFE: DROP-then-ADD guarded on `pg_constraint`, matching every
-- other widened-CHECK migration in this program.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'outcome_event_kind_chk') THEN
    ALTER TABLE "outcome_event" DROP CONSTRAINT "outcome_event_kind_chk";
  END IF;
  ALTER TABLE "outcome_event" ADD CONSTRAINT "outcome_event_kind_chk" CHECK ("kind" IN (
    'response_received', 'meeting_scheduled', 'meeting_held',
    'language_included', 'funding_changed', 'filing_completed',
    'commitment_secured', 'no_action',
    'pursuit_won', 'pursuit_lost', 'pursuit_passed',
    'regulatory_action_published'
  ));
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'outcome_event_source_type_chk') THEN
    ALTER TABLE "outcome_event" DROP CONSTRAINT "outcome_event_source_type_chk";
  END IF;
  ALTER TABLE "outcome_event" ADD CONSTRAINT "outcome_event_source_type_chk" CHECK ("source_type" IN (
    'outreach', 'meeting', 'artifact', 'campaign', 'submission', 'manual',
    'funding_opportunity',
    'regulatory_document'
  ));
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_profile_fill_finding_kind_check') THEN
    ALTER TABLE client_profile_fill_finding DROP CONSTRAINT client_profile_fill_finding_kind_check;
  END IF;
  ALTER TABLE client_profile_fill_finding ADD CONSTRAINT client_profile_fill_finding_kind_check CHECK (kind IN (
    'profile_field',
    'government_identity',
    'person',
    'facility',
    'capability',
    'lda_identity',
    'lda_history',
    'program_element',
    'bill_recommendation',
    'relationship_link',
    'federal_footprint',
    'facility_resolution',
    'district_nexus',
    'advocacy_record',
    'advocacy_outcome',
    'regulatory_outcome',
    'profile_completion'
  ));
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_profile_fill_finding_source_check') THEN
    ALTER TABLE client_profile_fill_finding DROP CONSTRAINT client_profile_fill_finding_source_check;
  END IF;
  ALTER TABLE client_profile_fill_finding ADD CONSTRAINT client_profile_fill_finding_source_check CHECK (source IN (
    'public_web',
    'website',
    'synced_email',
    'sam_gov',
    'lda',
    'program_elements',
    'client_document',
    'bill_tracker',
    'advocacy_history',
    'completion_audit',
    'district_nexus',
    'facility_resolution',
    'federal_market',
    'lifecycle_outcomes',
    'reconciliation',
    'federal_register'
  ));
END $$;
