-- Phase 4: reviewable links from authoritative synced meetings/mail threads
-- into the existing Relationships > History projection.
--
-- The source records remain canonical; this migration only extends the finding
-- vocabulary so a human can review the proposed association before it is
-- applied through ClientAssociationOverride.

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
    'bill_recommendation',
    'relationship_link'
  ));
