param([ValidatePattern('^[a-z0-9-]+$')][string]$Attempt = 'before-fix')
$ErrorActionPreference = 'Stop'
$repo = 'C:\dev\main\meri-c1-20261002'
$out = 'C:\dev\main\outputs\meri-c2-20261003'
$prefix = Join-Path $out ('projection-postgres-' + $Attempt)
$cfgPath = 'C:\dev\main\outputs\meri-c1-20261002\private\local-postgres.json'
$data = 'C:\dev\main\outputs\meri-c1-20261002\private\pgdata'
$pgctl = 'C:\dev\main\.tools\postgresql-16.15-c1\pgsql\bin\pg_ctl.exe'
$cfg = Get-Content -Raw -LiteralPath $cfgPath | ConvertFrom-Json
if ($cfg.host -cne '127.0.0.1' -or $cfg.port -ne 55433 -or $cfg.scope -cne 'owned local disposable test cluster; no AWS connection') { throw 'LOCAL_CONFIG_GUARD' }
if ([IO.Path]::GetFullPath($cfg.dataDirectory) -ne [IO.Path]::GetFullPath($data)) { throw 'DATA_DIRECTORY_GUARD' }
if ((Get-Content -Raw -LiteralPath (Join-Path $data 'PG_VERSION')).Trim() -ne '16') { throw 'POSTGRES_VERSION_GUARD' }
if (Test-Path -LiteralPath ($prefix + '.json')) { throw 'ATTEMPT_EXISTS' }
$sourceFiles = @('apps/api/src/memory/memory-store.service.ts', 'apps/api/src/memory/memory-clio-adapter.helpers.ts', 'evals/meri/live-v1/tests/memory-projection-governance.postgres.test.mjs', 'evals/meri/live-v1/tests/approved-memory-postgres-harness.mjs', 'evals/meri/live-v1/tests/approved-memory-schema.mjs')
$receipt = [ordered]@{
  kind = 'C2 actual projection owner regression'; startedAt = [DateTime]::UtcNow.ToString('o');
  scope = 'owned native PostgreSQL16 127.0.0.1:55433 only; rollback-only fixtures; not production RLS';
  awsCalls = 0; providerCalls = 0; sourceHashes = [ordered]@{};
  command = 'node --test evals/meri/live-v1/tests/memory-projection-governance.postgres.test.mjs'
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
  & node --test evals/meri/live-v1/tests/memory-projection-governance.postgres.test.mjs *> ($prefix + '.log')
  $receipt.testExit = $LASTEXITCODE
  $receipt.testLogSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath ($prefix + '.log')).Hash.ToLowerInvariant()
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
  $env:MERI_APPROVED_MEMORY_PG_CONFIG = $oldConfig
  Pop-Location
  $receipt.completedAt = [DateTime]::UtcNow.ToString('o')
  $receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath ($prefix + '.json')
}
$receipt | ConvertTo-Json -Depth 8
if ($receipt.testExit -ne 0 -or $receipt.runnerError -or -not $receipt.clusterStoppedAfter) { exit 1 }
