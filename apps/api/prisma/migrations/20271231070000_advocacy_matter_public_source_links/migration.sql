-- Public source coverage -> Matter linking (closeout PR, product spec
-- section 9-14).
--
-- Reuses existing canonical GLOBAL reference tables -- regulatory_docket,
-- federal_register_document, committee_hearing, fara_registration -- none
-- of which carry a tenant_id (confirmed: no RLS, shared across all
-- tenants, per their own schema section comments). This migration does
-- NOT touch those tables. It only extends client_advocacy_matter_link
-- (which IS tenant/client scoped) with five new source types so a
-- specific Matter can point at a specific public record.
--
-- link_key holds the referenced table's own natural key:
--   regulatory_docket   -> document_id
--   regulatory_document -> federal_register_document.document_number
--   hearing             -> committee_hearing.id (uuid text)
--   testimony           -> committee_hearing.id + '::' + witness name
--                          (committee_hearing has no separate testimony
--                          row -- witnesses is a bare text[] column; see
--                          service-layer comment for the honest coverage
--                          gap this reflects)
--   fara_record         -> fara_registration.registration_number
--
-- CPF (House Community Project Funding) and CDS (Senate Congressionally
-- Directed Spending) are deliberately NOT added here: confirmed absent
-- from this repo (no canonical table, no ingestion service, no existing
-- migration references either concept). Per spec section 12, "if
-- canonical records exist, support" -- they do not, so nothing is added.
-- Reported as an unsupported source, not silently faked.

ALTER TABLE client_advocacy_matter_link DROP CONSTRAINT IF EXISTS client_advocacy_matter_link_type_check;
ALTER TABLE client_advocacy_matter_link ADD CONSTRAINT client_advocacy_matter_link_type_check CHECK (link_type IN (
  'program_element', 'bill', 'outcome_event', 'finding',
  'meeting', 'mail_thread', 'outreach', 'strategy',
  'regulatory_docket', 'regulatory_document', 'hearing', 'testimony', 'fara_record'
));

-- Section 10/11/13: every public-source link carries PUBLIC_VERIFIED
-- evidence. Stored once here (not per-row in metadata_jsonb) so the read
-- path never has to reach into JSON to render an evidence badge; NULL for
-- every pre-existing/private link type this migration doesn't touch.
ALTER TABLE client_advocacy_matter_link ADD COLUMN IF NOT EXISTS evidence_class VARCHAR(32) NULL;
ALTER TABLE client_advocacy_matter_link DROP CONSTRAINT IF EXISTS client_advocacy_matter_link_evidence_class_check;
ALTER TABLE client_advocacy_matter_link ADD CONSTRAINT client_advocacy_matter_link_evidence_class_check CHECK (
  evidence_class IS NULL OR evidence_class IN ('PUBLIC_VERIFIED', 'CLIENT_VERIFIED', 'PRIVATE_ACTIVITY', 'INFERRED')
);
