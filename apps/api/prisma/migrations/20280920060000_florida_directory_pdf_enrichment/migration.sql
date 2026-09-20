-- Additive provenance for official state-legislative directory enrichment.
-- OpenStates remains authoritative for the canonical person columns; the PDF
-- importer writes PDF facts only under source_evidence.directoryPdf. Read APIs
-- use validated PDF email/image fallbacks only when canonical values are blank.
ALTER TABLE "state_legislator"
ADD COLUMN "source_evidence" JSONB;

COMMENT ON COLUMN "state_legislator"."source_evidence" IS
  'Source-scoped additive enrichment (for example official directory PDF offices, aides, and provenance).';
