# Canonical budget setup after the actual case01 recovery

Prepared local-only. Do not run until c22 API/orchestrator promotion is verified and the original recovery has completed all stages with `SETUP_COMPLETE`. Keep other T1 fixture/binding changes and main commits paused between each one-off prepare/run pair. The existing frozen `case01-oneoff.py` supports both budget commands already; it is unchanged. No new cloud operator is needed.

Every output below is a new `-c22-` path under the frozen operator's required `oct02-case01-release` directory. Retain existing inputs, receipts and locks. An ambiguous task outcome must be reconciled; never rerun the command or delete its lock. Recovery must precede any case14/20/72 binding change.

The input builder pins the actual reviewed provider evidence, including its four provider/model rates and expiry. Its explicit per-case ceilings are **USD3**, **200000 total tokens**, and **32 total provider attempts**, with concurrency1 enforced by capture. Attempts do not authorize extra chat turns. The first installation refuses an already present prior qualification; unexpected prior state needs reconciliation. Rates are accounting upper bounds, not an assertion of the invoice amount.

## 1. Canonical read-only budget plan

Run each block separately, inspect its output and actual receipts before continuing. This first preparation makes read-only AWS calls; the subsequent `run` registers/runs one DB-read-only owner task.

```powershell
$budgetRoot = 'C:\dev\cap-meri-foundation-evidence\oct02-case01-release'
$releaseRoot = 'C:\dev\cap-meri-foundation-evidence\oct02-live-repair-release'
$budgetPython = 'C:\ProgramData\Hermes\installs\404726bdd5a78951\environments\89b9c16e9db3445e8b190ec8bf8f65c5\venv\Scripts\python.exe'
$budgetOperator = "$budgetRoot\case01-oneoff.py"
$budgetRepo = 'C:\dev\cap-meri-outcomes-validation'
$budgetProof = "$releaseRoot\api-oneoff-build-proof.json"
$budgetProofHash = 'fcb9f085721fb17c33ef01f8005304f6478168b2dbef008c15e762a4deca446c'
if ((Get-FileHash -LiteralPath $budgetOperator).Hash.ToLowerInvariant() -ne '4df33cccadd3fdc15711872de3c0ffe2602249a8765c0e6ff36d05488085d36a') { throw 'Frozen operator changed' }
if ((Get-FileHash -LiteralPath $budgetProof).Hash.ToLowerInvariant() -ne $budgetProofHash) { throw 'New API proof changed' }
$budgetInput = "$budgetRoot\budget-plan-input.json"
$budgetInputHash = 'dc7cfd41ef037f8b594c7b6716bbd4c21da16a257cb4297f01567ef1399deb4b'
$budgetCommon = @('--repo',$budgetRepo,'--proof',$budgetProof,'--proof-sha256',$budgetProofHash)
& $budgetPython $budgetOperator prepare --mode budget-plan @budgetCommon --input $budgetInput --input-sha256 $budgetInputHash --out "$budgetRoot\budget-plan-c22-task-plan.json"
if ($LASTEXITCODE -ne 0) { throw 'Read-only budget plan preparation refused' }
```

After inspecting the exact planned source/image/baseline and confirming recovery is complete:

```powershell
$budgetTaskPlan = "$budgetRoot\budget-plan-c22-task-plan.json"
$budgetTaskPlanHash = (Get-Content -LiteralPath $budgetTaskPlan -Raw | ConvertFrom-Json).planHash
& $budgetPython $budgetOperator run --mode budget-plan @budgetCommon --input $budgetInput --input-sha256 $budgetInputHash --plan $budgetTaskPlan --plan-sha256 $budgetTaskPlanHash --confirm RUN_ONE_REVIEWED_CASE01_TASK --out "$budgetRoot\budget-plan-c22-execution.json"
if ($LASTEXITCODE -ne 0) { throw 'Budget-plan task needs reconciliation; do not replay' }
```

Require actual `VERIFIED`, exit0 and exactly one `READY_FOR_RATE_QUALIFICATION` receipt for case01. Its run/current source/binding must match the completed recovery. This fresh receipt supplies the tenant row version and prior-qualification hash; do not use old CAS values.

## 2. Derive and install the exact qualification

This local derivation reads each reviewed receipt once and parses those same hash-checked bytes, rejects duplicate JSON keys, verifies the original task-plan hash/binding/source and freshly qualified recovery, and copies exact CAS fields. It never calls AWS or DB and creates its input exclusively. It requires unexpired reviewed rates for at least the next30 minutes.

```powershell
$budgetPlanExecutionHash = (Get-FileHash -LiteralPath "$budgetRoot\budget-plan-c22-execution.json").Hash.ToLowerInvariant()
$budgetRecoveryExecutionHash = (Get-FileHash -LiteralPath "$budgetRoot\case01-recovery-execute-execution.json").Hash.ToLowerInvariant()
& $budgetPython "$releaseRoot\materialize-case01-budget-install.py" --plan-execution-sha256 $budgetPlanExecutionHash --recovery-execution-sha256 $budgetRecoveryExecutionHash
if ($LASTEXITCODE -ne 0) { throw 'Local input derivation refused; no install submitted' }
$budgetInstallInput = "$budgetRoot\budget-install-c22-input.json"
$budgetInstallInputHash = (Get-FileHash -LiteralPath $budgetInstallInput).Hash.ToLowerInvariant()
& $budgetPython $budgetOperator prepare --mode budget-install @budgetCommon --input $budgetInstallInput --input-sha256 $budgetInstallInputHash --out "$budgetRoot\budget-install-c22-task-plan.json"
if ($LASTEXITCODE -ne 0) { throw 'Budget-install preparation refused' }
```

After reviewing the derived qualification, exact limits/rates/CAS and the prepared task:

```powershell
$budgetInstallPlan = "$budgetRoot\budget-install-c22-task-plan.json"
$budgetInstallPlanHash = (Get-Content -LiteralPath $budgetInstallPlan -Raw | ConvertFrom-Json).planHash
& $budgetPython $budgetOperator run --mode budget-install @budgetCommon --input $budgetInstallInput --input-sha256 $budgetInstallInputHash --plan $budgetInstallPlan --plan-sha256 $budgetInstallPlanHash --confirm RUN_ONE_REVIEWED_CASE01_TASK --out "$budgetRoot\budget-install-c22-execution.json"
if ($LASTEXITCODE -ne 0) { throw 'Budget-install outcome needs reconciliation; do not replay' }
```

Require `VERIFIED`, exit0, exactly one `PROVIDER_QUALIFICATION_INSTALLED` owner receipt, matching actual source/run/current binding, exact qualification hash, ceiling and rate evidence. The canonical installer rehydrates current memory and performs real tenant-row/settings compare-and-swap. A stale plan cannot write over a changed owner/binding. Neither budget task invokes a provider or sends a Meri turn.

## 3. Preserve actual receipt aliases for the existing capture driver

Only after verified success, copy the two exact original byte arrays to new exclusive aliases (no normalization or overwrite):

```powershell
$budgetCopies = @(
  @("$budgetRoot\case01-recovery-execute-execution.json", "$releaseRoot\recovery-execute-execution.json"),
  @("$budgetRoot\budget-install-c22-execution.json", "$releaseRoot\budget-install-execution.json")
)
foreach ($budgetCopy in $budgetCopies) {
  $budgetBytes = [IO.File]::ReadAllBytes($budgetCopy[0])
  $budgetDestination = [IO.File]::Open($budgetCopy[1], [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $budgetDestination.Write($budgetBytes,0,$budgetBytes.Length); $budgetDestination.Flush($true) } finally { $budgetDestination.Dispose() }
}
node "$releaseRoot\seal-local-live-inputs.mjs" --seal-case01
if ($LASTEXITCODE -ne 0) { throw 'Capture inputs refused; do not authenticate' }
node "$releaseRoot\run-case01-authenticated-v2.mjs" --check-readiness
if ($LASTEXITCODE -ne 0) { throw 'Capture local readiness refused' }
```

The source-owned native collector remains the final current-auth/source/build/budget/empty-conversation gate immediately before one actual turn. Follow `LOCAL-BROWSER-OPERATORS.md`; no capture or human grade is claimed by this budget runbook.
