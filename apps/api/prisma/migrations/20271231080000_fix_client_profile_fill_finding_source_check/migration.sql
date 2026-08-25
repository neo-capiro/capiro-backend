-- Fix: client_profile_fill_finding_source_check never included the seven
-- `source` values the Fill-with-Meri completion workflow
-- (client-profile-fill-completion.service.ts) has written since it shipped
-- in migration 20271231030000_client_profile_fill_completion:
--   advocacy_history, completion_audit, district_nexus, facility_resolution,
--   federal_market, lifecycle_outcomes, reconciliation
--
-- Discovered live 2026-08-24 during the Advocacy History production canary:
-- the advocacy_history extension task failed with
-- `client_profile_fill_finding_source_check` (23514) the first time it had
-- a real client_submission_history-derived finding to insert. Auditing the
-- full completion service showed the SAME missing-value gap on all seven
-- source strings the completion workflow ever writes -- the advocacy_history
-- migration (and every migration after it) added these seven values to the
-- `client_profile_fill_extension_task_type_check` constraint but never to
-- this sibling `client_profile_fill_finding_source_check` constraint on a
-- different table. completion_audit runs unconditionally on every Fill run
-- (regardless of whether the client has any advocacy data), so this defect
-- was silently failing every completion-workflow Fill run's audit step in
-- production before this fix, not just the advocacy path.
--
-- Preserve every prior allowed value from
-- 20261015010000_client_profile_fill_with_meri,
-- 20261120210000_client_profile_fill_capability_document, and
-- 20261219010000_client_profile_fill_bill_recommendation.

ALTER TABLE client_profile_fill_finding
  DROP CONSTRAINT IF EXISTS client_profile_fill_finding_source_check;

ALTER TABLE client_profile_fill_finding
  ADD CONSTRAINT client_profile_fill_finding_source_check
  CHECK (source IN (
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
    'reconciliation'
  ));
