-- Add a nullable full-email column to acquisition_personnel.
--
-- Most personnel sources are captured domain-only (email_domain) as a PII/ToS
-- defense-in-depth measure. SAM.gov solicitation POCs, however, publish a full
-- contact email that is legitimately useful to capiro_admin. We now persist it
-- when a source provides it; the READ layer gates exposure to capiro_admin only
-- (every other caller still sees email_domain), so this column is written for a
-- few sources and never surfaced broadly.
--
-- Nullable, no backfill, no index (not a query key). Idempotent so re-applying is safe.
ALTER TABLE "acquisition_personnel"
  ADD COLUMN IF NOT EXISTS "email" TEXT;
