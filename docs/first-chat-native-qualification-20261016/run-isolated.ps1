# Exact-target local PostgreSQL qualification. Do not run until approval for
# initializing this task-owned cluster and executing the focused SQL is granted.
$ErrorActionPreference = 'Stop'

$taskRoot = 'C:\Users\Administrator\Documents\Codex\2026-10-16\task-3'
$repo = Join-Path $taskRoot 'capiro-backend'
$clusterRoot = Join-Path $taskRoot 'isolated-postgres-20261016'
$dataDir = Join-Path $clusterRoot 'data'
$evidenceDir = Join-Path $taskRoot 'core-bootstrap-native-evidence'
$pgBin = 'C:\Program Files\PostgreSQL\16\bin'
$node24 = 'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$tsx = Join-Path $repo 'apps\api\node_modules\tsx\dist\cli.mjs'
$qualifier = Join-Path $repo 'docs\first-chat-native-qualification-20261016\qualify.mjs'
$runId = [Guid]::NewGuid().ToString('N')
$pwFile = Join-Path $taskRoot ('.pg-core-bootstrap-' + $runId + '.pw')
$rawLog = Join-Path $clusterRoot 'server.log'
$report = Join-Path $evidenceDir ('first-chat-native-' + $runId + '.txt')
$serverReport = Join-Path $evidenceDir ('postgres-' + $runId + '.txt')
$oldDatabaseUrl = $env:DATABASE_URL
$oldNativeUrl = $env:CORE_BOOTSTRAP_NATIVE_DATABASE_URL
$oldNativeDir = $env:CORE_BOOTSTRAP_NATIVE_DATA_DIR
$oldPgPassword = $env:PGPASSWORD
$oldTsxTsconfigPath = $env:TSX_TSCONFIG_PATH
$secret = $null
$encodedSecret = $null
$databaseUrl = $null
$cleanupError = $null
$initAttempted = $false
$clusterRootCreated = $false

function Redact-Text([string] $value) {
  if ($databaseUrl) { $value = $value.Replace($databaseUrl, '[redacted database URL]') }
  if ($encodedSecret) { $value = $value.Replace($encodedSecret, '[redacted password]') }
  if ($secret) { $value = $value.Replace($secret, '[redacted password]') }
  return $value
}

function Assert-ExactCleanupTarget {
  $expected = [IO.Path]::GetFullPath((Join-Path $clusterRoot 'data'))
  $actual = [IO.Path]::GetFullPath($dataDir)
  $root = [IO.Path]::GetFullPath($taskRoot)
  if ($actual -cne $expected -or -not $actual.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Cluster cleanup target is outside the exact task-owned directory'
  }
  if (Test-Path -LiteralPath $actual) {
    $parentItem = Get-Item -LiteralPath $clusterRoot -Force
    if (($parentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'Refusing recursive cleanup under a reparse-point cluster root'
    }
    $item = Get-Item -LiteralPath $actual -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'Refusing recursive cleanup of a reparse-point directory'
    }
  }
  return $actual
}

try {
  if (Test-Path -LiteralPath $clusterRoot) { throw 'Exact isolated cluster root already exists' }
  if (Test-Path -LiteralPath $dataDir) { throw 'Exact isolated data directory already exists' }
  if (Test-Path -LiteralPath $rawLog) { throw 'Exact isolated server log already exists' }
  if (Get-NetTCPConnection -LocalPort 55417 -State Listen -ErrorAction SilentlyContinue) { throw 'Loopback port 55417 is already in use' }
  if ((Get-PSDrive -Name C).Free -lt 1536MB) { throw 'Less than 1.5 GiB is free on C:' }
  foreach ($required in @('initdb.exe', 'pg_ctl.exe', 'createdb.exe', 'postgres.exe')) {
    if (-not (Test-Path -LiteralPath (Join-Path $pgBin $required))) { throw ('Missing installed PostgreSQL binary: ' + $required) }
  }
  if (-not (Test-Path -LiteralPath $node24) -or -not (Test-Path -LiteralPath $tsx) -or -not (Test-Path -LiteralPath $qualifier)) {
    throw 'Bundled Node 24, tsx, or qualifier is missing'
  }
  $postgresVersion = & (Join-Path $pgBin 'postgres.exe') --version
  if ($LASTEXITCODE -ne 0 -or $postgresVersion -notmatch 'PostgreSQL\) 16\.15\b') { throw 'Installed postgres.exe is not 16.15' }
  $nodeVersion = & $node24 --version
  if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v24\.') { throw 'Bundled Node is not version 24' }

  New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
  New-Item -ItemType Directory -Path $clusterRoot -Force | Out-Null
  $clusterRootCreated = $true
  $secretBytes = New-Object byte[] 48
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($secretBytes) } finally { $rng.Dispose() }
  $secret = [Convert]::ToBase64String($secretBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  $encodedSecret = [Uri]::EscapeDataString($secret)
  [IO.File]::WriteAllText($pwFile, $secret, [Text.Encoding]::ASCII)

  # SCRAM applies only to this new disposable cluster. No host-service files,
  # firewall policy, global role, ACL or persistent credential is changed.
  $initAttempted = $true
  & (Join-Path $pgBin 'initdb.exe') -D $dataDir -U postgres --auth-host=scram-sha-256 --auth-local=scram-sha-256 --pwfile=$pwFile
  if ($LASTEXITCODE -ne 0) { throw 'initdb failed for the exact task-owned cluster' }
  Remove-Item -LiteralPath $pwFile -Force

  & (Join-Path $pgBin 'pg_ctl.exe') -w -D $dataDir -l $rawLog -o '-h 127.0.0.1 -p 55417' start
  if ($LASTEXITCODE -ne 0) { throw 'The exact isolated PostgreSQL cluster failed to start' }
  if ((Get-PSDrive -Name C).Free -lt 1024MB) { throw 'Less than 1 GiB remains after isolated cluster startup' }
  $env:PGPASSWORD = $secret
  & (Join-Path $pgBin 'createdb.exe') -h 127.0.0.1 -p 55417 -U postgres capiro_bootstrap_native_qual
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the exact disposable qualification database' }

  $databaseUrl = 'postgresql://postgres:' + $encodedSecret + '@127.0.0.1:55417/capiro_bootstrap_native_qual?sslmode=disable'
  $env:DATABASE_URL = $databaseUrl
  $env:CORE_BOOTSTRAP_NATIVE_DATABASE_URL = $databaseUrl
  $env:CORE_BOOTSTRAP_NATIVE_DATA_DIR = $dataDir
  $env:TSX_TSCONFIG_PATH = Join-Path $repo 'apps\api\tsconfig.json'
  $runnerOutput = & $node24 $tsx $qualifier --run 2>&1
  $runnerExit = $LASTEXITCODE
  $sanitized = Redact-Text (($runnerOutput | Out-String -Width 400))
  [IO.File]::WriteAllText($report, ('target: task-owned PostgreSQL 16.15, 127.0.0.1:55417/capiro_bootstrap_native_qual' + [Environment]::NewLine + 'runnerExit: ' + $runnerExit + [Environment]::NewLine + $sanitized))
  Write-Output $sanitized
  if ($runnerExit -ne 0) { throw ('Native qualifier exited ' + $runnerExit + '; see sanitized evidence') }
} finally {
  $env:DATABASE_URL = $oldDatabaseUrl
  $env:CORE_BOOTSTRAP_NATIVE_DATABASE_URL = $oldNativeUrl
  $env:CORE_BOOTSTRAP_NATIVE_DATA_DIR = $oldNativeDir
  $env:PGPASSWORD = $oldPgPassword
  $env:TSX_TSCONFIG_PATH = $oldTsxTsconfigPath
  if (Test-Path -LiteralPath $pwFile) { Remove-Item -LiteralPath $pwFile -Force }

  if ($initAttempted -and (Test-Path -LiteralPath $dataDir)) {
    & (Join-Path $pgBin 'pg_ctl.exe') -D $dataDir status *> $null
    if ($LASTEXITCODE -eq 0) {
      & (Join-Path $pgBin 'pg_ctl.exe') -w -D $dataDir stop -m fast
      if ($LASTEXITCODE -ne 0) { $cleanupError = 'Could not stop exact isolated cluster; data directory retained' }
    }
  }
  if ($initAttempted -and (Test-Path -LiteralPath $rawLog)) {
    try {
      [IO.File]::WriteAllText($serverReport, (Redact-Text ([IO.File]::ReadAllText($rawLog))))
      Remove-Item -LiteralPath $rawLog -Force
    } catch {
      $cleanupError = 'Could not save sanitized PostgreSQL log; raw task-owned log retained'
    }
  }
  if ($initAttempted -and -not $cleanupError -and (Test-Path -LiteralPath $dataDir)) {
    & (Join-Path $pgBin 'pg_ctl.exe') -D $dataDir status *> $null
    if ($LASTEXITCODE -eq 0) { throw 'Exact isolated PostgreSQL process is still running; data directory retained' }
    if (Get-NetTCPConnection -LocalPort 55417 -State Listen -ErrorAction SilentlyContinue) {
      throw 'Port 55417 still has a listener; data directory retained'
    }
    $pidFile = Join-Path $dataDir 'postmaster.pid'
    if (Test-Path -LiteralPath $pidFile) {
      $recordedPid = 0
      $firstPidLine = Get-Content -LiteralPath $pidFile -TotalCount 1
      if ([int]::TryParse($firstPidLine, [ref]$recordedPid) -and (Get-Process -Id $recordedPid -ErrorAction SilentlyContinue)) {
        throw 'A process still owns the recorded postmaster PID; data directory retained'
      }
    }
    $exactTarget = Assert-ExactCleanupTarget
    Remove-Item -LiteralPath $exactTarget -Recurse -Force
  }
  if ($clusterRootCreated -and -not $cleanupError -and (Test-Path -LiteralPath $clusterRoot)) {
    # Succeeds only when the exact parent is empty; never recurse here.
    Remove-Item -LiteralPath $clusterRoot -Force -ErrorAction SilentlyContinue
  }
  $secret = $null
  $encodedSecret = $null
  $databaseUrl = $null
  if ($cleanupError) { throw $cleanupError }
}
