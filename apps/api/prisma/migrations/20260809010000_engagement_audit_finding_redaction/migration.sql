-- Engagement remediation closeout — exact-version audit-ledger data minimization.
--
-- OutreachDraftAuditService needs durable check/severity evidence, but raw auditor
-- findings may also carry `span` and `detail` excerpts from recipient-facing text
-- or source evidence. Exact-version outreach rows must never persist those fields.
--
-- This migration:
--   1. installs a BEFORE trigger that retains only check/severity/source for
--      surface='outreach' + subject_type='outreach-draft-version'; and
--   2. rewrites existing exact-version rows through that trigger.
--
-- Other surfaces and legacy outreach rows with no exact subject are untouched.
-- Rollback: DROP TRIGGER, DROP FUNCTION. The redacted fields cannot be restored
-- without a database backup, which is intentional data minimization.

CREATE OR REPLACE FUNCTION redact_outreach_audit_findings()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_findings jsonb;
BEGIN
  IF NEW.surface = 'outreach'
     AND NEW.subject_type = 'outreach-draft-version' THEN
    source_findings := CASE
      WHEN jsonb_typeof(COALESCE(NEW.findings_jsonb, '[]'::jsonb)) = 'array'
        THEN COALESCE(NEW.findings_jsonb, '[]'::jsonb)
      ELSE '[]'::jsonb
    END;

    NEW.findings_jsonb := COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'check', item ->> 'check',
            'severity', COALESCE(NULLIF(item ->> 'severity', ''), 'unknown'),
            'source', COALESCE(NULLIF(item ->> 'source', ''), 'meri_auditor')
          )
        )
        FROM jsonb_array_elements(source_findings) AS item
        WHERE jsonb_typeof(item) = 'object'
          AND NULLIF(item ->> 'check', '') IS NOT NULL
      ),
      '[]'::jsonb
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS meri_audit_ledger_redact_outreach_findings
  ON meri_audit_ledger;

CREATE TRIGGER meri_audit_ledger_redact_outreach_findings
BEFORE INSERT OR UPDATE OF findings_jsonb, surface, subject_type
ON meri_audit_ledger
FOR EACH ROW
EXECUTE FUNCTION redact_outreach_audit_findings();

-- Fire the trigger for exact-version rows already written before this migration.
UPDATE meri_audit_ledger
SET findings_jsonb = findings_jsonb
WHERE surface = 'outreach'
  AND subject_type = 'outreach-draft-version';
