<#
.SYNOPSIS
  Run the P17 Tango capability probe (read-only) without the API key ever
  appearing in a terminal, a transcript, or the saved report.

.DESCRIPTION
  Fetches the Tango key from AWS Secrets Manager into a local variable, runs
  diag-tango-capabilities.ts, and clears the variable afterwards. The key is
  never echoed, never passed as an argument, and never written to disk.

  The probe is read-only: every call is a GET or the smallest possible LIST.
  No create/update/delete is ever issued.

  As of D-64 the `dibbs` probe is a REAL call (one listRfqs, limit 1) rather
  than a hardcoded "unsupported". A live run therefore answers two questions
  at once: whether this account is entitled to DIBBS, and whether the
  pagination envelope matches what TangoDibbsClient assumes. An envelope
  mismatch surfaces as a named error, not as an empty page.

  WHO MAY RUN THIS: an operator, at a keyboard. Plan section 4.6 forbids a key
  passing through an agent session, and the standing capiro-dev AWS approval
  does NOT override that. An agent must not run this script.

  ASCII ONLY. PowerShell 5.1 on Windows reads a BOM-less UTF-8 file as
  Windows-1252, so an em-dash becomes three bytes whose embedded quote breaks
  parsing several lines later -- with an error pointing at the wrong line. Use
  plain hyphens.

.PARAMETER RepoPath
  Path to the capirov2 checkout to run from. Defaults to the checkout that
  contains this script, which is normally what you want.

  Do NOT point this at a working checkout that sits on a feature branch. Two
  separate failure modes: a checkout predating P40 part 3 has no
  TangoDibbsClient and reports dibbs as not_attempted (see the guard below),
  and a dirty tree makes the run unreproducible. A detached worktree at a known
  commit is the reliable shape:

    git -C <repo> worktree add --detach C:\dev\capiro-p17-wt origin/main
    cd C:\dev\capiro-p17-wt; pnpm install --frozen-lockfile

.PARAMETER RequestCeiling
  Self-imposed cap on HTTP calls. See the parameter's own comment: 25, never 30.

.EXAMPLE
  .\run-p17-probe.ps1

.EXAMPLE
  .\run-p17-probe.ps1 -RepoPath C:\dev\capiro-p17-wt
#>
param(
  # Defaults to the repo containing this script:
  # docs/plans/funding-opportunities-makegov-v1/operator -> four levels up.
  [string]$RepoPath = (Join-Path $PSScriptRoot '..\..\..\..'),

  # 25, not 30. The account is capped at 25 requests per ~31s (D-65), so a
  # ceiling of 30 sits ABOVE the provider's own limit and can never bind --
  # which is the defect D-65 fixed in the probe's default. An explicit 30 from
  # a launcher REINSTATES it. Do not raise this above the account limit.
  [int]$RequestCeiling = 25,

  [string]$SecretId = 'tango',
  [string]$AwsProfile = 'capiro-dev',
  [string]$AwsRegion = 'us-east-1',

  # Where the structured report lands. The report contains no credential --
  # every reason string is redacted by the probe itself.
  #
  # Timestamped per run, and deliberately NOT a fixed filename. A captured
  # report is the record of a run: the 2026-08-08 run is the only live-provider
  # evidence this program has, and a fixed name meant the next run silently
  # overwrote it. Defaults outside the repo so a report is never accidentally
  # committed.
  [string]$OutFile = (Join-Path $env:USERPROFILE "p17-capability-report-$(Get-Date -Format 'yyyyMMdd-HHmmss').json")
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $RepoPath)) {
  throw "RepoPath not found: $RepoPath"
}
$RepoPath = (Resolve-Path -LiteralPath $RepoPath).Path

if (-not (Test-Path -LiteralPath (Join-Path $RepoPath 'package.json'))) {
  throw "RepoPath is not a repo root (no package.json): $RepoPath"
}

# A checkout without the DIBBS client still RUNS. It reports dibbs as
# not_attempted / no_rest_client_wired, which reads exactly like an entitlement
# answer and is not one -- the D-64 failure mode, one layer out. Fail loudly.
$dibbsClient = Join-Path $RepoPath 'apps\api\src\external\tango\tango-dibbs.client.ts'
if (-not (Test-Path -LiteralPath $dibbsClient)) {
  throw @"
This checkout predates P40 part 3 -- TangoDibbsClient is missing:
  $dibbsClient

The probe would run and report dibbs as not_attempted, which is NOT an
entitlement answer. Update the checkout to a main containing merge commit
094daf1d (PR #857), then re-run.
"@
}

if (-not (Get-Command aws -ErrorAction SilentlyContinue)) {
  throw "The 'aws' CLI is not on PATH."
}
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  throw "'pnpm' is not on PATH."
}

# Never clobber an existing report. See the OutFile comment.
if (Test-Path -LiteralPath $OutFile) {
  throw "Refusing to overwrite an existing report: $OutFile"
}

Write-Host "Repo:   $RepoPath"
Write-Host "Report: $OutFile"
Write-Host ''
Write-Host "Fetching the Tango key from Secrets Manager (value is never displayed)..."

# --output text on a plain-string secret. Captured into a variable, not echoed.
# Multi-line output would arrive as an array, so it is flattened before use.
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
# identical to a successful one until the probe reported a bogus auth failure.
if ([string]::IsNullOrWhiteSpace($secret)) {
  throw "The secret came back empty. Nothing was run."
}
Write-Host ("Key retrieved ({0} characters). Not displayed." -f $secret.Length)

Push-Location $RepoPath
try {
  $env:TANGO_API_KEY = $secret

  Write-Host "Running the probe (read-only, ceiling $RequestCeiling)..."
  Write-Host ''

  # Human summary goes to stderr and stays on screen; the structured report is
  # stdout and is redirected to a file, exactly as the script's own doc intends.
  pnpm --filter @capiro/api exec tsx scripts/diag-tango-capabilities.ts `
    --request-ceiling=$RequestCeiling | Out-File -FilePath $OutFile -Encoding utf8

  $probeExit = $LASTEXITCODE

  Write-Host ''
  Write-Host "Structured report written to: $OutFile"

  if ($probeExit -ne 0) {
    Write-Warning "The probe exited $probeExit. A non-zero exit usually means the version preflight hit an authentication failure -- read the summary above."
  } else {
    Write-Host "Probe completed. Check the 'dibbs' row: 'supported' answers P40's entitlement question."
    Write-Host "If it reports an envelope problem, that is a contract finding -- update dibbs-sbir-rest-contract.md and capture a fixture. Do NOT widen the client to accept both shapes."
  }
}
finally {
  # Always clear, including on failure.
  Remove-Item Env:\TANGO_API_KEY -ErrorAction SilentlyContinue
  $secret = $null
  [System.GC]::Collect()
  Pop-Location
  Write-Host 'TANGO_API_KEY cleared from this session.'
}
