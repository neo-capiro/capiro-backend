-- Source only. No backfill from legacy publication/comment/effective timestamps.
ALTER TABLE federal_register_document
  ADD COLUMN effective_date_evidence jsonb,
  ADD COLUMN effective_date_observed_at timestamptz;
ALTER TABLE federal_register_document
  ADD CONSTRAINT federal_register_effective_evidence_pair CHECK (
    (effective_date_evidence IS NULL AND effective_date_observed_at IS NULL)
    OR (effective_date_evidence IS NOT NULL AND effective_date_observed_at IS NOT NULL
      AND jsonb_typeof(effective_date_evidence) = 'object'
      AND (effective_date_evidence->>'schemaVersion' = '1') IS TRUE
      AND (effective_date_evidence->>'dateKind' = 'effective') IS TRUE
      AND (effective_date_evidence->>'documentNumber' = document_number) IS TRUE)
  );
CREATE INDEX federal_register_document_type_effective_date_idx
  ON federal_register_document(type, effective_date);
