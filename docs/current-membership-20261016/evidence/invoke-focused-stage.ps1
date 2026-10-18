param([string]$OutputPrefix = 'focused-attempt1', [ValidateSet('primary', 'membership')][string]$Suite = 'primary')
$ErrorActionPreference = 'Stop'
if ($OutputPrefix -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_.-]*$') { throw 'Invalid evidence prefix' }
$stageRoot = $PSScriptRoot
$taskRoot = Split-Path -Parent $stageRoot
$stagePath = Join-Path $stageRoot "$OutputPrefix.stage.json"
if (Test-Path -LiteralPath $stagePath) { throw 'Preserve existing stage receipt; choose a fresh authorized prefix' }
$stdoutPath = Join-Path $stageRoot "$OutputPrefix.stdout.log"
$stderrPath = Join-Path $stageRoot "$OutputPrefix.stderr.log"
$nodePath = 'C:\Program Files\nodejs\node.exe'
$nodeArgs = @('--max-old-space-size=512', 'current-authority-runtime/run-focused.cjs', '--suite', $Suite, '--output-prefix', $OutputPrefix)
$record = [ordered]@{ startedAtUtc = [DateTime]::UtcNow.ToString('o'); executable = $nodePath; argv = $nodeArgs; workingDirectory = $taskRoot; hardWallMs = 58000; approvedSuite = $Suite; processId = $null; primaryExit = $null; timedOut = $false; peakWorkingSetBytes = 0L; peakPrivateBytes = 0L; cleanupExit = $null; terminalAtUtc = $null; ownedProcessRemains = $null }
$ownedProcess = $null
$wall = [Diagnostics.Stopwatch]::StartNew()
try {
  $ownedProcess = Start-Process -FilePath $nodePath -ArgumentList $nodeArgs -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
  $record.processId = $ownedProcess.Id
  $record | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $stagePath -Encoding utf8
  while (-not $ownedProcess.WaitForExit(200)) {
    $ownedProcess.Refresh()
    $record.peakWorkingSetBytes = [Math]::Max($record.peakWorkingSetBytes, $ownedProcess.PeakWorkingSet64)
    $record.peakPrivateBytes = [Math]::Max($record.peakPrivateBytes, $ownedProcess.PrivateMemorySize64)
    if ($wall.ElapsedMilliseconds -ge 58000) {
      $record.timedOut = $true
      $ownedProcess.Kill()
      break
    }
  }
  if (-not $ownedProcess.WaitForExit(1000)) { throw 'Owned focused process has not terminated after hard stop' }
  $record.primaryExit = $ownedProcess.ExitCode
} catch {
  $record.error = $_.Exception.Message
} finally {
  if ($null -ne $ownedProcess) {
    $ownedProcess.Refresh()
    if (-not $ownedProcess.HasExited) { $ownedProcess.Kill(); [void]$ownedProcess.WaitForExit(1000) }
    $record.ownedProcessRemains = -not $ownedProcess.HasExited
    $record.cleanupExit = $(if ($record.ownedProcessRemains) { 1 } else { 0 })
    $ownedProcess.Dispose()
  } else { $record.cleanupExit = 0; $record.ownedProcessRemains = $false }
  $record.elapsedMs = $wall.ElapsedMilliseconds
  $record.terminalAtUtc = [DateTime]::UtcNow.ToString('o')
  $record | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $stagePath -Encoding utf8
}
Get-Content -LiteralPath $stagePath
if ($record.primaryExit -ne 0 -or $record.timedOut -or $record.cleanupExit -ne 0 -or $record.Contains('error')) { exit 1 }
