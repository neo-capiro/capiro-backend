param([ValidatePattern('^[a-z0-9-]+$')][string]$Attempt = 'v1')
$ErrorActionPreference = 'Stop'
$repo = 'C:\dev\main\meri-c1-20261002'
$out = 'C:\dev\main\outputs\meri-c2-20261003\case12-eligibility-supervised-v2'
$prefix = Join-Path $out ('case12-eligibility-' + $Attempt)
$cfgPath = 'C:\dev\main\outputs\meri-c1-20261002\private\local-postgres.json'
$expectedData = 'C:\dev\main\outputs\meri-c1-20261002\private\pgdata'
$pgctl = 'C:\dev\main\.tools\postgresql-16.15-c1\pgsql\bin\pg_ctl.exe'
$cfg = Get-Content -Raw -LiteralPath $cfgPath | ConvertFrom-Json
if ($cfg.host -cne '127.0.0.1' -or $cfg.port -ne 55433 -or $cfg.user -cne 'meri_c1_owner' -or $cfg.database -cne 'postgres' -or $cfg.scope -cne 'owned local disposable test cluster; no AWS connection') { throw 'LOCAL_CONFIG_GUARD' }
$data = (Resolve-Path -LiteralPath $expectedData).Path
if ((Resolve-Path -LiteralPath $cfg.dataDirectory).Path -cne $data) { throw 'DATA_DIRECTORY_GUARD' }
if ([IO.Path]::GetFullPath($data) -cne [IO.Path]::GetFullPath($expectedData)) { throw 'RESOLVED_DATA_DIRECTORY_GUARD' }
if ((Get-Content -Raw -LiteralPath (Join-Path $data 'PG_VERSION')).Trim() -cne '16') { throw 'POSTGRES_VERSION_GUARD' }
if (Get-ChildItem -LiteralPath $out -Filter ('case12-eligibility-' + $Attempt + '*')) { throw 'ATTEMPT_EXISTS' }
$sourceFiles = @(
 'apps/api/src/memory/memory-candidate.service.ts',
 'apps/api/src/memory/memory-store.service.ts',
 'apps/api/src/memory/memory-authorization.service.ts',
 'apps/api/src/memory/synthetic-approved-memory.helpers.ts',
 'apps/api/src/memory/memory-canonical-activation.helpers.ts',
 'apps/api/src/retrieval/adapters/institutional-knowledge-retrieval.adapter.ts',
 'apps/api/src/memory/memory-wall.helpers.ts',
 'apps/api/src/memory/memory-recall-suppression.helpers.ts',
 'packages/meriv2-core/src/memory/governance.ts',
 'evals/meri/live-v1/fixture-provisioning/approved-memory-runtime.mjs',
 'apps/api/prisma/schema.prisma'
)
$scratchFiles = @(
 'apps/api/src/retrieval/adapters/institutional-knowledge-retrieval.adapter.ts',
 'apps/api/src/retrieval/adapters/institutional-knowledge-retrieval.original-baseline.ts',
 'apps/api/src/retrieval/adapters/governed-memory-eligibility.helpers.ts',
 'apps/api/src/retrieval/adapters/case12-memory-eligibility.read.ts',
 'evals/meri/live-v1/fixture-provisioning/case12-memory-inventory-owner.mjs',
 'evals/meri/live-v1/fixture-provisioning/case12-memory-eligibility-owner.mjs',
 'evals/meri/live-v1/tests/case12-eligibility.postgres.test.mjs',
 'evals/meri/live-v1/tests/approved-memory-postgres-independent-harness.mjs',
 'evals/meri/live-v1/tests/approved-memory-schema.mjs'
)
function Read-CoreHashes {
  $coreRoot = Join-Path $repo 'packages/meriv2-core/dist'
  $hashes = [ordered]@{}
  foreach ($file in (Get-ChildItem -LiteralPath $coreRoot -Recurse -File -Filter '*.js' | Sort-Object FullName)) {
    $relative = $file.FullName.Substring($repo.Length + 1).Replace('\', '/')
    $hashes[$relative] = (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash.ToLowerInvariant()
  }
  return $hashes
}
$receipt = [ordered]@{
  kind = 'Case12 actual canonical services, inventory, eligibility and lookup parity in owned disposable PostgreSQL'
  startedAt = [DateTime]::UtcNow.ToString('o')
  scope = 'owned PostgreSQL16 127.0.0.1:55433 only; service transactions commit inside a new uniquely marked random schema, qualification uses repeatable-read, exact schema dropped in finally; no production RLS or authority issuance claim'
  awsCalls = 0
  providerCalls = 0
  sourceHashes = [ordered]@{}
  scratchHashes = [ordered]@{}
  command = 'node --test C:/dev/main/outputs/meri-c2-20261003/case12-eligibility-supervised-v2/scratch/evals/meri/live-v1/tests/case12-eligibility.postgres.test.mjs'
}
$oldConfig = $env:MERI_APPROVED_MEMORY_PG_CONFIG
$startIssued = $false
Push-Location $repo
try {
  $receipt.sourceSha = (& git rev-parse HEAD).Trim()
  foreach ($relative in $sourceFiles) {
    $source = Join-Path $repo $relative
    $receipt.sourceHashes[$relative] = (Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash.ToLowerInvariant()
    Copy-Item -LiteralPath $source -Destination ($prefix + '-source-' + ($relative -replace '[/\\]', '_'))
  }
  foreach ($relative in $scratchFiles) {
    $receipt.scratchHashes[$relative] = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path (Join-Path $out 'scratch') $relative)).Hash.ToLowerInvariant()
  }
  $coreBefore = Read-CoreHashes
  $coreBefore | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath ($prefix + '-built-core.json')
  $receipt.builtCoreFileCount = $coreBefore.Count
  $receipt.builtCoreManifestSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath ($prefix + '-built-core.json')).Hash.ToLowerInvariant()
  $listeners = @(Get-NetTCPConnection -LocalPort 55433 -State Listen -ErrorAction SilentlyContinue)
  $receipt.listenersBefore = $listeners.Count
  if ($listeners.Count -ne 0) { throw 'LOCAL_PORT_ALREADY_LISTENING' }
  & $pgctl -D $data status *> ($prefix + '-status-before.log')
  $receipt.statusBeforeExit = $LASTEXITCODE
  if ($LASTEXITCODE -ne 3) { throw 'CLUSTER_NOT_STOPPED' }
  $startIssued = $true
  $proc = Start-Process -FilePath $pgctl -WindowStyle Hidden -PassThru -ArgumentList @('-D', $data, '-l', ($prefix + '-postgres.log'), '-o', '"-h 127.0.0.1 -p 55433"', '-w', '-t', '30', 'start') -RedirectStandardOutput ($prefix + '-start.stdout') -RedirectStandardError ($prefix + '-start.stderr')
  if (-not $proc.WaitForExit(35000)) { throw 'START_TIMEOUT' }
  $proc.Refresh()
  $receipt.startExit = $proc.ExitCode
  if ($proc.ExitCode -ne 0) { throw 'START_FAILED' }
  $env:MERI_APPROVED_MEMORY_PG_CONFIG = $cfgPath
  & node --test C:/dev/main/outputs/meri-c2-20261003/case12-eligibility-supervised-v2/scratch/evals/meri/live-v1/tests/case12-eligibility.postgres.test.mjs *> ($prefix + '.log')
  $receipt.testExit = $LASTEXITCODE
  $receipt.testLogSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath ($prefix + '.log')).Hash.ToLowerInvariant()
  $coreAfter = Read-CoreHashes
  $receipt.builtCoreUnchanged = ($coreBefore | ConvertTo-Json -Compress -Depth 4) -ceq ($coreAfter | ConvertTo-Json -Compress -Depth 4)
  $receipt.sourceUnchanged = $true
  foreach ($relative in $sourceFiles) {
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $repo $relative)).Hash.ToLowerInvariant() -cne $receipt.sourceHashes[$relative]) { $receipt.sourceUnchanged = $false }
  }
  $receipt.scratchUnchanged = $true
  foreach ($relative in $scratchFiles) {
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path (Join-Path $out 'scratch') $relative)).Hash.ToLowerInvariant() -cne $receipt.scratchHashes[$relative]) { $receipt.scratchUnchanged = $false }
  }
} catch {
  $receipt.runnerErrorType = $_.Exception.GetType().FullName
  $receipt.runnerError = $_.Exception.Message
} finally {
  if ($startIssued) {
    $stop = Start-Process -FilePath $pgctl -WindowStyle Hidden -PassThru -ArgumentList @('-D', $data, '-m', 'fast', '-w', '-t', '30', 'stop') -RedirectStandardOutput ($prefix + '-stop.stdout') -RedirectStandardError ($prefix + '-stop.stderr')
    if ($stop.WaitForExit(35000)) { $stop.Refresh(); $receipt.stopExit = $stop.ExitCode } else { $receipt.stopTimedOut = $true }
  }
  & $pgctl -D $data status *> ($prefix + '-status-after.log')
  $receipt.clusterStoppedAfter = $LASTEXITCODE -eq 3
  $receipt.listenersAfter = @(Get-NetTCPConnection -LocalPort 55433 -State Listen -ErrorAction SilentlyContinue).Count
  $env:MERI_APPROVED_MEMORY_PG_CONFIG = $oldConfig
  Pop-Location
  $receipt.completedAt = [DateTime]::UtcNow.ToString('o')
  $receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath ($prefix + '.receipt.json')
}
$receipt | ConvertTo-Json -Depth 8
if ($receipt.testExit -ne 0 -or $receipt.runnerError -or -not $receipt.clusterStoppedAfter -or $receipt.listenersAfter -ne 0 -or -not $receipt.builtCoreUnchanged -or -not $receipt.sourceUnchanged -or -not $receipt.scratchUnchanged) { exit 1 }
