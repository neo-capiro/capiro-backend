<#
.SYNOPSIS
  Capture one small page of REAL records from every Tango DIBBS and SBIR/STTR
  endpoint, so P40-P43's field types can finally be checked against reality.

.DESCRIPTION
  READ-ONLY. Five GETs, five records each. No database, no writes, no mutation.

  WHY THIS RUN MATTERS
  --------------------------------------------------------------------------
  P17's capability probe answered ENTITLEMENT and confirmed the pagination
  ENVELOPE for both datasets. It captures no response bodies. So every field
  TYPE, NULL SEMANTIC and DATE FORMAT in the schema, the mappers, the sync and
  the scorers is still a reading of a published field NAME -- documentation,
  not observation.

  This is the "full contract validation" the completion matrix has listed as
  the real gate since P40. It is the smallest thing that closes it.

  WHY AN OPERATOR RUNS IT AND NOT AN AGENT
  --------------------------------------------------------------------------
  Plan 4.6: the Tango key must never pass through an agent session. This script
  fetches it from Secrets Manager, never displays it, and clears it in a
  finally block -- the same handling run-p17-probe.ps1 uses. Every error string
  the capture writes is passed through both redactors first, because a provider
  that echoes the request back in an error body is the one path by which a key
  could otherwise reach an artifact.

  RATE BUDGET
  --------------------------------------------------------------------------
  Five requests. P17 measured this account at 25 per ~31s, so this fits inside
  one window with room to spare. Run it on a FRESH window if you have just run
  the probe.

.PARAMETER RepoPath
  Checkout to run from. Defaults to the checkout containing this script.

  Do NOT point this at a working checkout on a feature branch. A checkout
  predating P42 part 1 has no TangoSbirClient and cannot capture the SBIR
  endpoints at all; the guard below hard-fails rather than producing a partial
  artifact that looks complete.

.PARAMETER OutFile
  Where the artifact lands. Defaults to a TIMESTAMPED file in your profile
  directory, deliberately OUTSIDE the repo: a capture is evidence, and it must
  not be committed by accident or destroyed by the next run. The script refuses
  to overwrite an existing file.

.EXAMPLE
  C:\dev\capture.cmd
#>
[CmdletBinding()]
param(
  [string]$RepoPath = (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)))),
  [string]$AwsProfile = 'capiro-dev',
  [string]$AwsRegion = 'us-east-1',
  [string]$SecretId = 'tango',
  [string]$OutFile = (Join-Path $env:USERPROFILE "tango-contract-capture-$(Get-Date -Format 'yyyyMMdd-HHmmss').json")
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $RepoPath)) {
  throw "RepoPath not found: $RepoPath"
}
$RepoPath = (Resolve-Path -LiteralPath $RepoPath).Path

if (-not (Test-Path -LiteralPath (Join-Path $RepoPath 'package.json'))) {
  throw "RepoPath is not a repo root (no package.json): $RepoPath"
}

# A checkout missing either REST client still RUNS and writes an artifact whose
# missing endpoints look like provider failures rather than a stale checkout.
# Same trap run-p17-probe.ps1 guards, and the same table-driven shape so adding
# a rail is one line.
$requiredRestClients = @(
  @{ Name = 'TangoDibbsClient'; Path = 'apps\api\src\external\tango\tango-dibbs.client.ts'; Since = 'P40 part 3' },
  @{ Name = 'TangoSbirClient';  Path = 'apps\api\src\external\tango\tango-sbir.client.ts';  Since = 'P42 part 1' }
)
foreach ($client in $requiredRestClients) {
  $clientPath = Join-Path $RepoPath $client.Path
  if (-not (Test-Path -LiteralPath $clientPath)) {
    throw @"
This checkout predates $($client.Since) -- $($client.Name) is missing:
  $clientPath

The capture would run and record that dataset as failed, which reads like a
provider problem and is not one. Update the checkout, then re-run.
"@
  }
}

$captureScript = Join-Path $RepoPath 'apps\api\scripts\diag-tango-contract-capture.ts'
if (-not (Test-Path -LiteralPath $captureScript)) {
  throw "Capture script missing: $captureScript"
}

if (-not (Get-Command aws -ErrorAction SilentlyContinue))  { throw "The 'aws' CLI is not on PATH." }
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { throw "'pnpm' is not on PATH." }

# Never clobber a capture. A captured artifact is evidence.
if (Test-Path -LiteralPath $OutFile) {
  throw "Refusing to overwrite an existing capture: $OutFile"
}

Write-Host "Repo:    $RepoPath"
Write-Host "Capture: $OutFile"
Write-Host ''
Write-Host 'Fetching the Tango key from Secrets Manager (value is never displayed)...'

$secret = aws secretsmanager get-secret-value `
  --secret-id $SecretId `
  --profile $AwsProfile `
  --region $AwsRegion `
  --query SecretString `
  --output text

if ($LASTEXITCODE -ne 0) {
  throw "aws secretsmanager get-secret-value failed (exit $LASTEXITCODE). Check the profile and your SSO/session state."
}
if ($secret -is [array]) { $secret = ($secret -join '') }
$secret = "$secret".Trim()

# Length only -- never the value. A silent empty fetch would otherwise look
# identical to a successful one until the capture reported a bogus auth failure.
if ([string]::IsNullOrWhiteSpace($secret)) {
  throw 'The secret came back empty. Nothing was run.'
}
Write-Host ("Key retrieved ({0} characters). Not displayed." -f $secret.Length)

Push-Location $RepoPath
try {
  $env:TANGO_API_KEY = $secret

  Write-Host 'Capturing 5 endpoints, 5 records each (read-only)...'
  Write-Host ''

  pnpm --filter @capiro/api exec tsx scripts/diag-tango-contract-capture.ts --out "$OutFile"
  $captureExit = $LASTEXITCODE

  Write-Host ''
  if ($captureExit -ne 0) {
    Write-Warning "The capture exited $captureExit. Read the per-endpoint lines above."
  }
  if (Test-Path -LiteralPath $OutFile) {
    Write-Host "Capture written to: $OutFile"
    Write-Host ''
    Write-Host 'Send that file back. What it answers:'
    Write-Host '  - MISSING documented fields  -> the contract doc is wrong, or the field is detail-endpoint only.'
    Write-Host '  - UNDOCUMENTED fields present -> the doc is incomplete and we may be discarding something.'
    Write-Host '  - observed types vs the columns -> whether the schema guessed right.'
    Write-Host ''
    Write-Host 'An ENVELOPE MISMATCH is a contract finding: update dibbs-sbir-rest-contract.md and'
    Write-Host 'capture a fixture. Do NOT widen a client to accept both shapes.'
  } else {
    Write-Warning 'No capture file was written.'
  }
}
finally {
  Remove-Item Env:\TANGO_API_KEY -ErrorAction SilentlyContinue
  $secret = $null
  [System.GC]::Collect()
  Pop-Location
  Write-Host 'TANGO_API_KEY cleared from this session.'
}
