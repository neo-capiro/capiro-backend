$ErrorActionPreference = 'Stop'
$repoRoot = 'C:\Users\neoma\Documents\Codex\2026-10-15\task-10\backend-cleanup'
$sourceCommit = '4e0c189c5d0522098be1c4916a033bb681d11c0b'
$generator = 'scripts/engagement-phase3-preview-route-patterns.mjs'
$oldOutput = 'apps/web/src/lib/engagement-api-preview-routes.generated.ts'
$newOutput = 'tests/support/legacy-web/source-inputs/engagement-api-preview-routes.generated.ts.txt'
$utf8 = [System.Text.UTF8Encoding]::new($false, $true)

function Read-GitBytes([string]$spec) {
  $start = [System.Diagnostics.ProcessStartInfo]::new()
  $start.FileName = 'git'
  $start.WorkingDirectory = $repoRoot
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.ArgumentList.Add('show')
  $start.ArgumentList.Add($spec)
  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $start
  [void]$process.Start()
  $errorTask = $process.StandardError.ReadToEndAsync()
  $buffer = [System.IO.MemoryStream]::new()
  $process.StandardOutput.BaseStream.CopyTo($buffer)
  $process.WaitForExit()
  $errorText = $errorTask.GetAwaiter().GetResult()
  if ($process.ExitCode -ne 0) { throw "git show failed for ${spec}: $errorText" }
  return ,$buffer.ToArray()
}
function Sha256([byte[]]$bytes) {
  return [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}
function LfBytes([byte[]]$bytes) {
  return ,$utf8.GetBytes($utf8.GetString($bytes).Replace("`r`n", "`n"))
}
function BlobOf([byte[]]$bytes) {
  $prefix = $utf8.GetBytes("blob $($bytes.Length)" + [char]0)
  $blobData = [byte[]]::new($prefix.Length + $bytes.Length)
  [Array]::Copy($prefix, 0, $blobData, 0, $prefix.Length)
  [Array]::Copy($bytes, 0, $blobData, $prefix.Length, $bytes.Length)
  return [Convert]::ToHexString([System.Security.Cryptography.SHA1]::HashData($blobData)).ToLowerInvariant()
}

$baseline = Read-GitBytes "${sourceCommit}:$generator"
$working = [System.IO.File]::ReadAllBytes((Join-Path $repoRoot $generator))
$workingLf = LfBytes $working
$currentText = $utf8.GetString($workingLf)
$oldMatches = ([regex]::Matches($utf8.GetString($baseline), [regex]::Escape($oldOutput))).Count
$newMatches = ([regex]::Matches($currentText, [regex]::Escape($newOutput))).Count
$inverse = $utf8.GetBytes($currentText.Replace($newOutput, $oldOutput))
$inverseExact = (Sha256 $inverse) -eq (Sha256 $baseline)
if ($oldMatches -ne 1 -or $newMatches -ne 1 -or -not $inverseExact) { throw 'Generator changed beyond the one approved output-path substitution.' }

$fixturePaths = @(
  'apps/api/src/engagement/__fixtures__/engagement-route-manifest.v1.json',
  'apps/api/src/outreach-v3/__fixtures__/outreach-v3-route-manifest.v1.json',
  'apps/api/src/outreach-v3/__fixtures__/outreach-v3-reasoning-route-manifest.v1.json',
  'apps/api/src/outreach-v3/__fixtures__/outreach-v3-target-route-manifest.v1.json',
  'apps/api/src/outreach-v3/__fixtures__/outreach-v3-context-route-manifest.v1.json',
  'apps/api/src/outreach-v3/__fixtures__/outreach-v3-generation-route-manifest.v1.json',
  'apps/api/src/outreach-v3/__fixtures__/outreach-v3-drafts-route-manifest.v1.json',
  'apps/api/src/outreach-v3/__fixtures__/outreach-v3-send-route-manifest.v1.json',
  'apps/api/src/outreach-v3/__fixtures__/outreach-v3-templates-route-manifest.v1.json'
)
$routeRows = [System.Collections.Generic.List[object]]::new()
$fixtures = foreach ($fixturePath in $fixturePaths) {
  $sourceBytes = Read-GitBytes "${sourceCommit}:$fixturePath"
  $currentBytes = [System.IO.File]::ReadAllBytes((Join-Path $repoRoot $fixturePath))
  $currentLf = LfBytes $currentBytes
  $sourceText = $utf8.GetString($sourceBytes)
  $unchanged = (Sha256 $sourceBytes) -eq (Sha256 $currentLf)
  if (-not $unchanged) { throw "Route fixture changed: $fixturePath" }
  $manifest = ConvertFrom-Json $sourceText
  $sourceLines = $sourceText.Split("`n")
  foreach ($route in $manifest.routes) {
    $pathToken = '"path": "' + $route.path + '"'
    $line = 0
    for ($i = 0; $i -lt $sourceLines.Length; $i++) {
      if ($sourceLines[$i].Contains($pathToken)) { $line = $i + 1; break }
    }
    $routeRows.Add([pscustomobject][ordered]@{ path=$route.path; method=$route.method; source=$fixturePath; line=$line })
  }
  [ordered]@{
    path=$fixturePath; sourceBlob=(BlobOf $sourceBytes); sourceBytes=$sourceBytes.Length;
    sourceSha256=(Sha256 $sourceBytes); workingBytes=$currentBytes.Length;
    workingSha256=(Sha256 $currentBytes); workingCanonicalLfSha256=(Sha256 $currentLf);
    byteExact=((Sha256 $sourceBytes) -eq (Sha256 $currentBytes)); canonicalLfExact=$unchanged
  }
}
$exclusions = @('/api/internal/ai-credentials/resolve', '/webhooks/recall')
$rejected = @($routeRows | Where-Object { -not $_.path.StartsWith('/api/engagement/') -and $_.path -notin $exclusions } | Sort-Object path -Unique)
if ($rejected.Count -ne 5) { throw "Unexpected source rejection count: $($rejected.Count)" }
$diagnosticPath = Join-Path $repoRoot '..\evidence\owned-preview-pattern-drift-check.stderr'
$diagnosticBytes = [System.IO.File]::ReadAllBytes($diagnosticPath)
$diagnosticText = $utf8.GetString($diagnosticBytes)
foreach ($route in $rejected) {
  $expected = "FAIL  manifest path $($route.path) is outside /api/engagement/ and is not in the reviewed EXCLUSIONS table"
  if (-not $diagnosticText.Contains($expected)) { throw "Native diagnostic does not name $($route.path)" }
}
if (-not $diagnosticText.Contains('ENGAGEMENT_PREVIEW_ROUTE_PATTERNS_INVALID (5)')) { throw 'Native diagnostic count mismatch.' }
$outputSource = Read-GitBytes "${sourceCommit}:$oldOutput"
$outputCurrent = [System.IO.File]::ReadAllBytes((Join-Path $repoRoot $newOutput))
if ((Sha256 $outputSource) -ne (Sha256 $outputCurrent)) { throw 'Archived generated operand is not byte-exact.' }
$receipt = [ordered]@{
  sourceCommit=$sourceCommit;
  classification='Inherited protective route-authority failure; not cleanup-induced output drift';
  basis='Static source/data comparison only. No generator, test, compiler, browser, database, install or build executed by this analysis.';
  generator=[ordered]@{
    path=$generator; sourceBlob=(BlobOf $baseline); sourceBytes=$baseline.Length; sourceSha256=(Sha256 $baseline);
    workingBytes=$working.Length; workingSha256=(Sha256 $working); workingCanonicalLfSha256=(Sha256 $workingLf);
    approvedInverse=[ordered]@{ replace=$newOutput; with=$oldOutput; occurrences=1; reconstructedSha256=(Sha256 $inverse); byteExactToCanonicalGit=$inverseExact };
    ruleChanges=0
  };
  unchangedManifests=$fixtures;
  unchangedRules=[ordered]@{ previewPrefix='/api/engagement'; exclusions=$exclusions; proof='Complete generator inverse equals sealed Git source, including all prefix/exclusion/validation code.' };
  generatedOperand=[ordered]@{ source=$oldOutput; destination=$newOutput; sourceBlob=(BlobOf $outputSource); bytes=$outputSource.Length; sha256=(Sha256 $outputSource); byteExact=$true; comparedByObservedCommand=$false };
  rejectedHistoricalRoutes=$rejected;
  parentObservedDiagnostic=[ordered]@{ path='evidence/owned-preview-pattern-drift-check.stderr'; bytes=$diagnosticBytes.Length; sha256=(Sha256 $diagnosticBytes); marker='ENGAGEMENT_PREVIEW_ROUTE_PATTERNS_INVALID (5)'; failureCount=5 };
  qualificationBoundary='The guard fails before rendering or reading the generated output. Output-path relocation cannot produce these errors; all five route/rule disagreements are present at sealed source4e. Current backend preview-route acceptance remains unqualified. No authority/exclusion/table/contract change is made.'
}
$receiptPath = Join-Path $repoRoot '..\evidence\preview-pattern-inherited-failure-source-proof.json'
[System.IO.File]::WriteAllText($receiptPath, (ConvertTo-Json $receipt -Depth 12) + "`n", $utf8)
Write-Output "Recorded source inverse and nine unchanged route manifests; five inherited rejected routes. No runtime checks executed. Receipt: $receiptPath"
