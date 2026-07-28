-- District Nexus F3 eligibility had no input.
--
-- `computeEligibility` (grant-opportunity-relevance.ts) compares a client's
-- Grants.gov "Eligible Applicants" values against an opportunity's
-- `eligibleApplicantTypes`, which reads `federal_grant.eligibility` — LABEL
-- strings, not numeric codes. There was no column to compare against, so
-- `shapeClientRelevanceProfile` hardcoded `applicantTypes: []` and the function
-- could only ever return `needs_review` or `unknown` — never `eligible`. The
-- column was honest but inert.
--
-- Additive and safe: NOT NULL with an empty-array default, so every existing row
-- gets `{}` and behaviour is byte-identical until a client is deliberately
-- populated. Empty means "we do not know", which keeps the needs_review answer
-- correct rather than guessing an applicant type from the sector and telling
-- someone they can apply for a grant they cannot.
ALTER TABLE "client"
  ADD COLUMN IF NOT EXISTS "applicant_types" TEXT[] NOT NULL DEFAULT '{}';
