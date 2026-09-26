# Exercises the actual source query against PostgreSQL using transaction-local
# temporary tables only. Does not read or modify existing application tables.
[CmdletBinding()]
param([ValidatePattern('^[a-zA-Z0-9_.-]+$')][string]$Container = 'capiro-postgres')
$ErrorActionPreference = 'Stop'
$sourcePath = Join-Path $PSScriptRoot '../../src/business-development/bizdev-dossier.service.ts'
$source = Get-Content -LiteralPath $sourcePath -Raw
$pattern = '(?s)SELECT "recipient_uei" AS "recipientUei", COUNT\(\*\)::int AS "awardCount",.*?GROUP BY "recipient_uei"'
$matchesFound = [regex]::Matches($source, $pattern)
if ($matchesFound.Count -ne 1) { throw 'Could not identify exactly one candidate award projection in source.' }
$query = $matchesFound[0].Value.Replace('${pageUeis}', "ARRAY['UEI-PARITY-A', 'UEI-PARITY-B']")
if ($query.Contains('${')) { throw 'Unresolved query binding.' }
$prelude = @'
BEGIN;
CREATE TEMP TABLE federal_award (
  id uuid, recipient_uei text, amount numeric(18,2), action_date date,
  award_unique_id text, last_synced_at timestamptz, description text,
  awarding_agency text, contractor_name text, recipient_state text
) ON COMMIT DROP;
INSERT INTO federal_award VALUES
('00000000-0000-0000-0000-000000000001', 'UEI-PARITY-A', 0, '2026-09-25', 'AWARD_LATEST_ZERO', '2026-09-25T10:00:00Z', 'Latest zero obligation', NULL, 'Current recipient', NULL),
('00000000-0000-0000-0000-000000000002', 'UEI-PARITY-A', 15000000.25, '2026-09-25', 'AWARD_SAME_DATE_LATER_ID', '2026-09-25T11:00:00Z', 'Tied date, later id', 'Other agency', 'Other recipient', 'VA'),
('00000000-0000-0000-0000-000000000003', 'UEI-PARITY-A', 99999999.99, '2025-01-01', 'AWARD_OLD', '2025-01-01T00:00:00Z', 'Old description', 'Old agency', 'Old recipient', 'NY'),
('00000000-0000-0000-0000-000000000004', 'UEI-PARITY-B', -12.34, NULL, 'AWARD_NEGATIVE', '2026-09-25T12:00:00Z', 'Negative adjustment', 'Agency B', 'Recipient B', 'MD'),
('00000000-0000-0000-0000-000000000005', 'UNREQUESTED-UEI', 45, '2026-09-26', 'AWARD_UNREQUESTED', now(), 'Must not appear', 'Agency C', 'Recipient C', 'CA');
CREATE TEMP VIEW candidate_projection AS
'@
$assertions = @'
;
DO $test$
DECLARE candidate record;
BEGIN
  IF (SELECT COUNT(*) FROM candidate_projection) <> 2 THEN RAISE EXCEPTION 'UEI scope mismatch'; END IF;
  SELECT * INTO candidate FROM candidate_projection WHERE "recipientUei" = 'UEI-PARITY-A';
  IF candidate."awardCount" <> 3 OR candidate."latestAwardId" <> 'AWARD_LATEST_ZERO'
    OR candidate."latestAmount" <> 0 OR candidate."latestDescription" <> 'Latest zero obligation'
    OR candidate."latestContractorName" <> 'Current recipient'
    OR candidate."latestAwardingAgency" IS NOT NULL OR candidate."latestRecipientState" IS NOT NULL
    OR candidate."latestActionDate" <> '2026-09-25'::date
    OR candidate."latestFetchedAt" <> '2026-09-25T10:00:00Z'::timestamptz
  THEN RAISE EXCEPTION 'Latest-row projection mixed fields, skipped zero/null or broke tie ordering'; END IF;
  SELECT * INTO candidate FROM candidate_projection WHERE "recipientUei" = 'UEI-PARITY-B';
  IF candidate."latestAmount" <> -12.34 OR candidate."latestActionDate" IS NOT NULL
    OR candidate."latestAwardId" <> 'AWARD_NEGATIVE'
  THEN RAISE EXCEPTION 'Negative money or null event-date semantics changed'; END IF;
END $test$;
SELECT 'PASS: exact source SQL, consistent latest row, tie ordering, zero/null/negative fields, UEI isolation' AS result;
ROLLBACK;
'@
$sql = $prelude + "`n" + $query + "`n" + $assertions
$sql | & docker exec -i $Container sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL candidate-projection verification failed.' }
