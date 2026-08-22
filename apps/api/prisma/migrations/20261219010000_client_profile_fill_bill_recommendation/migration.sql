-- Fill with Meri: bill tracker recommendations + tracker source label.
-- Preserve every prior allowed value from
-- 20261015010000_client_profile_fill_with_meri and
-- 20261120210000_client_profile_fill_capability_document.

ALTER TABLE client_profile_fill_finding
  DROP CONSTRAINT IF EXISTS client_profile_fill_finding_kind_check;

ALTER TABLE client_profile_fill_finding
  ADD CONSTRAINT client_profile_fill_finding_kind_check
  CHECK (kind IN (
    'profile_field',
    'government_identity',
    'person',
    'facility',
    'capability',
    'lda_identity',
    'lda_history',
    'program_element',
    'bill_recommendation'
  ));

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
    'bill_tracker'
  ));
