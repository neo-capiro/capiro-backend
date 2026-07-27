-- Remediation plan §3.b2/§3.b5 (Engagement) — generic exact-subject
-- correlation for meri_audit_ledger, plus a dedupe key so a re-run of the
-- SAME exact draft version under the SAME auditor mode replaces its own
-- prior verdict instead of accumulating duplicate rows.
--
-- ADDITIVE ONLY: two nullable columns + one unique index. No DROP, no type
-- change, no NOT NULL without a DEFAULT. A retry (IF NOT EXISTS) is a no-op.
-- Every existing row gets subject_type = NULL, subject_id = NULL — byte-
-- identical to today's behavior for every reader that doesn't know these
-- columns exist, and Postgres never treats two NULLs as conflicting under a
-- unique index, so the other surfaces writing this table today (chat,
-- research, memo, alert — none of which set these columns) are unaffected.

ALTER TABLE "meri_audit_ledger"
  ADD COLUMN IF NOT EXISTS "subject_type" VARCHAR(32);
ALTER TABLE "meri_audit_ledger"
  ADD COLUMN IF NOT EXISTS "subject_id" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "meri_audit_ledger_subject_mode_key"
  ON "meri_audit_ledger" ("tenant_id", "subject_type", "subject_id", "mode");
