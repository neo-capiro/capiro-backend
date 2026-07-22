-- E-signature ceremony fields on onboard_consent (Flow 1.5).
-- All columns are additive and nullable (email_copy_requested defaults false):
-- consent rows are immutable SOC-2 evidence, so rows written before the e-sign
-- step are never backfilled and simply carry NULL signature metadata.
ALTER TABLE "onboard_consent"
  ADD COLUMN "signer_name"          TEXT,
  ADD COLUMN "signer_title"         TEXT,
  ADD COLUMN "signature_name"       TEXT,
  ADD COLUMN "signature_method"     TEXT,
  ADD COLUMN "envelope_id"          UUID,
  ADD COLUMN "doc_sha256"           TEXT,
  ADD COLUMN "email_copy_requested" BOOLEAN NOT NULL DEFAULT false;
