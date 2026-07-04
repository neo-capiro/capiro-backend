-- Provenance for derived office->program links (derive-office-program-links).
--
-- program_office_program_link previously had no evidence/basis/cohort columns
-- (unlike pe_program_match). The office->program matcher needs them to be
-- auditable and to re-derive reversibly: it manages ONLY rows tagged with its
-- derived_by cohort and never touches hand/import-created rows (derived_by NULL).
--
-- All nullable / defaulted, no backfill. Idempotent so re-applying is safe.
ALTER TABLE "program_office_program_link"
  ADD COLUMN IF NOT EXISTS "evidence_jsonb" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS "evidence_tier" TEXT,
  ADD COLUMN IF NOT EXISTS "match_basis" TEXT,
  ADD COLUMN IF NOT EXISTS "derived_by" TEXT;
