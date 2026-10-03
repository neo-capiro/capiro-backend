param([ValidatePattern('^[a-z0-9-]+$')][string]$Attempt = 'v1')
$ErrorActionPreference = 'Stop'
$repo = 'C:\dev\main\meri-c1-20261002'
$out = 'C:\dev\main\outputs\meri-c2-20261003\capture-receipt-clock-v1'
$prefix = Join-Path $out ('capture-receipt-clock-' + $Attempt)
$cfgPath = 'C:\dev\main\outputs\meri-c1-20261002\private\local-postgres.json'
$expectedData = 'C:\dev\main\outputs\meri-c1-20261002\private\pgdata'
$pgctl = 'C:\dev\main\.tools\postgresql-16.15-c1\pgsql\bin\pg_ctl.exe'
$cfg = Get-Content -Raw -LiteralPath $cfgPath | ConvertFrom-Json
if ($cfg.host -cne '127.0.0.1' -or $cfg.port -ne 55433 -or $cfg.user -cne 'meri_c1_owner' -or $cfg.database -cne 'postgres' -or $cfg.scope -cne 'owned local disposable test cluster; no AWS connection') { throw 'LOCAL_CONFIG_GUARD' }
$data = (Resolve-Path -LiteralPath $expectedData).Path
if ((Resolve-Path -LiteralPath $cfg.dataDirectory).Path -cne $data) { throw 'DATA_DIRECTORY_GUARD' }
if ([IO.Path]::GetFullPath($data) -cne [IO.Path]::GetFullPath($expectedData)) { throw 'RESOLVED_DATA_DIRECTORY_GUARD' }
if ((Get-Content -Raw -LiteralPath (Join-Path $data 'PG_VERSION')).Trim() -cne '16') { throw 'POSTGRES_VERSION_GUARD' }
if (Get-ChildItem -LiteralPath $out -Filter ('capture-receipt-clock-' + $Attempt + '*')) { throw 'ATTEMPT_EXISTS' }
$sourceFiles = @(
  'evals/meri/live-v1/tests/capture-clock-receipt-jsonb.postgres.test.mjs',
  'evals/meri/live-v1/tests/approved-memory-postgres-harness.mjs',
  'evals/meri/live-v1/tests/approved-memory-schema.mjs',
  'apps/api/src/meri/meri-server-readonly-capture.ts',
  'apps/api/src/meri/meri-server-capture-evidence.ts',
  'apps/api/src/meri/meri-capture-policy-readback.ts',
  'apps/api/prisma/schema.prisma'
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
  kind = 'C2 pending clock receipt JSONB regression on actual generated Prisma/PostgreSQL'
  startedAt = [DateTime]::UtcNow.ToString('o')
  scope = 'owned PostgreSQL16 127.0.0.1:55433 only; each random schema and all rows rolled back; no production RLS or authority issuance claim'
  awsCalls = 0
  providerCalls = 0
  sourceHashes = [ordered]@{}
  command = 'node --test evals/meri/live-v1/tests/capture-clock-receipt-jsonb.postgres.test.mjs'
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
  & node --test evals/meri/live-v1/tests/capture-clock-receipt-jsonb.postgres.test.mjs *> ($prefix + '.log')
  $receipt.testExit = $LASTEXITCODE
  $receipt.testLogSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath ($prefix + '.log')).Hash.ToLowerInvariant()
  $coreAfter = Read-CoreHashes
  $receipt.builtCoreUnchanged = ($coreBefore | ConvertTo-Json -Compress -Depth 4) -ceq ($coreAfter | ConvertTo-Json -Compress -Depth 4)
  $receipt.sourceUnchanged = $true
  foreach ($relative in $sourceFiles) {
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $repo $relative)).Hash.ToLowerInvariant() -cne $receipt.sourceHashes[$relative]) { $receipt.sourceUnchanged = $false }
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
if ($receipt.testExit -ne 0 -or $receipt.runnerError -or -not $receipt.clusterStoppedAfter -or $receipt.listenersAfter -ne 0 -or -not $receipt.builtCoreUnchanged -or -not $receipt.sourceUnchanged) { exit 1 }
