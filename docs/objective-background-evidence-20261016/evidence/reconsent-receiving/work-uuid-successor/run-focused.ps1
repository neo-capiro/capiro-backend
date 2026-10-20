$ErrorActionPreference = 'Stop'
$evidenceDir = $PSScriptRoot
$repoDir = [IO.Path]::GetFullPath((Join-Path $evidenceDir '../../objective-background-evidence'))
$receiptPath = Join-Path $evidenceDir 'FOCUSED-RESULT.json'
if (Test-Path -LiteralPath $receiptPath) { throw 'Evidence exists; no automatic rerun' }
$nodePath = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$psi = [Diagnostics.ProcessStartInfo]::new()
$psi.FileName = $nodePath
$psi.WorkingDirectory = $repoDir
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
foreach ($item in @('--max-old-space-size=128','--require',(Join-Path $evidenceDir 'offline-source-guard.cjs'),'--require',(Join-Path $evidenceDir 'physical-admission.cjs'),'--experimental-strip-types','--test','--test-isolation=none','--test-concurrency=1','apps/api/test/objective-work-command.focused.test.mjs')) { $psi.ArgumentList.Add($item) }
$psi.Environment.Clear()
foreach ($key in @('SystemRoot','WINDIR','PATH','PATHEXT','TEMP','TMP')) {
  $value = [Environment]::GetEnvironmentVariable($key)
  if ($value) { $psi.Environment[$key] = $value }
}
$psi.Environment['NO_COLOR'] = '1'
$psi.Environment['NODE_ENV'] = 'test'
$proc = [Diagnostics.Process]::new()
$proc.StartInfo = $psi
$startedAt = [DateTime]::UtcNow
$clock = [Diagnostics.Stopwatch]::StartNew()
$timedOut = $false
try {
  if (-not $proc.Start()) { throw 'Failed to start the one source fixture' }
  $ownedPid = $proc.Id
  $stdout = $proc.StandardOutput.ReadToEndAsync()
  $stderr = $proc.StandardError.ReadToEndAsync()
  if (-not $proc.WaitForExit(120000)) {
    $timedOut = $true
    $proc.Kill($true)
    if (-not $proc.WaitForExit(5000)) { throw 'Owned source fixture cleanup unconfirmed' }
  }
  $clock.Stop()
  $outText = $stdout.GetAwaiter().GetResult()
  $errText = $stderr.GetAwaiter().GetResult()
  [IO.File]::WriteAllText((Join-Path $evidenceDir 'focused.stdout.log'), $outText)
  [IO.File]::WriteAllText((Join-Path $evidenceDir 'focused.stderr.log'), $errText)
  $record = [ordered]@{
    schemaVersion=1; baseCommit='622905839c7a510ab01a512ef8012926b2e1b4ce'; source='new-consent-and-canonical-receiving-candidate-pinned-separately';
    admission=@{source='Shipping relay of existing approved normal sample; no new security probe'; observedAt='2026-10-16T02:44:21Z'; availableVirtualBytes=3319373824; observedNotPeakGuarantee=$true; stage='one128MiB120s-source-stripped-process'};
    node=$nodePath; arguments=@($psi.ArgumentList); environmentNames=@($psi.Environment.Keys); pid=$ownedPid;
    startedAt=$startedAt.ToString('o'); completedAt=[DateTime]::UtcNow.ToString('o'); elapsedSeconds=$clock.Elapsed.TotalSeconds;
    exitCode=$proc.ExitCode; timedOut=$timedOut; ownedProcessExited=$proc.HasExited;
    peakWorkingSetBytes=$proc.PeakWorkingSet64; outputWithin4MiB=([Text.Encoding]::UTF8.GetByteCount($outText)+[Text.Encoding]::UTF8.GetByteCount($errText) -le 4MB);
    compiler=$false; database=$false; provider=$false; childrenAllowed=$false
  }
  $record | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $receiptPath -Encoding utf8
  $record | ConvertTo-Json -Depth 8 -Compress
  if ($timedOut -or -not $record.outputWithin4MiB) { exit 1 }
  exit $proc.ExitCode
} finally {
  if ($ownedPid -and -not $proc.HasExited) { $proc.Kill($true); $proc.WaitForExit(5000) | Out-Null }
  $proc.Dispose()
}
