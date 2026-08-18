-- Permit Fill with Meri findings derived from one tenant/client-owned capability document.
-- The document ID remains in evidence_jsonb; this deliberately avoids a second
-- attachment reference that could bypass the existing tenant/client ownership check.

ALTER TABLE client_profile_fill_finding
  DROP CONSTRAINT IF EXISTS client_profile_fill_finding_source_check;

ALTER TABLE client_profile_fill_finding
  ADD CONSTRAINT client_profile_fill_finding_source_check
  CHECK (source IN (
    'public_web', 'website', 'synced_email', 'sam_gov', 'lda', 'program_elements', 'client_document'
  ));
