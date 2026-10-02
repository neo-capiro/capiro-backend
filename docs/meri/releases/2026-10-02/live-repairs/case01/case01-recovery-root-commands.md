# Fixed case01 first-approval recovery

Prepared only; this lane made no AWS, live database or authentication calls. The original failed setup, successful V3 readback, original STARTED claim and candidate xmin113340385 remain immutable. This operator supports only the fixed `recover-plan` and `recover-execute` commands. It does not clear claims, alter roles/grants, run migrations or submit synthesis.

Before execution, root must finish and serialize other synthetic T1 setup work (including cases17/20/72), merge the reviewed recovery source into C-drive local main then GitHub main, build/qualify the exact API source, and promote that qualified API image. Keep T1 fixture settings stable from recovery plan through recovery execute. The operator independently requires clean HEAD==origin/main, exact reviewed recovery source blobs, current CodeBuild/import proof, immutable image/digest, healthy API baseline, existing qualified governance configuration, task/network/role bindings and original evidence. A docs-only main descendant of the image source is permitted by the frozen base helper; code drift is refused.

The fixed plan input already exists with SHA256 `18d066b6e7e9837d779d05cd85c6581ba6bd82bf5dd51ee95f56866744ad9c54`. Do not materialize it again. No plan task, execution input or recovery execution has been run by this lane.

Run these blocks separately as root. Set `$apiProof` to the reviewed immutable API qualification JSON for the newly deployed recovery image. No proof path or image is guessed in this preparation.

```powershell
$recoveryRoot = 'C:\dev\cap-meri-foundation-evidence\oct02-case01-release'
$recoveryPython = 'C:\ProgramData\Hermes\installs\404726bdd5a78951\environments\89b9c16e9db3445e8b190ec8bf8f65c5\venv\Scripts\python.exe'
$recoveryOperator = "$recoveryRoot\case01-recovery-oneoff.py"
$recoveryRepo = 'C:\dev\cap-meri-migration-history-guard'
# Set this to the actual reviewed qualification file after the recovery API image ships.
$apiProof = '<qualified-recovery-api-proof.json>'
$apiProofHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $apiProof).Hash.ToLowerInvariant()
$recoveryCommon = @('--repo', $recoveryRepo, '--proof', $apiProof, '--proof-sha256', $apiProofHash)
$recoveryPlanInput = "$recoveryRoot\case01-recovery-plan-input.json"
$recoveryPlanInputHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $recoveryPlanInput).Hash.ToLowerInvariant()

# Read-only AWS preparation; registers/runs nothing.
& $recoveryPython $recoveryOperator prepare --mode setup-recovery-plan @recoveryCommon --input $recoveryPlanInput --input-sha256 $recoveryPlanInputHash --out "$recoveryRoot\case01-recovery-plan-task-plan.json"
if ($LASTEXITCODE -ne 0) { throw 'Recovery plan preparation refused; inspect evidence without retrying a mutation.' }
```

After inspecting the prepared plan and confirming other T1 setup operations are quiescent:

```powershell
$recoveryTaskPlan = "$recoveryRoot\case01-recovery-plan-task-plan.json"
$recoveryTaskPlanHash = (Get-Content -LiteralPath $recoveryTaskPlan -Raw | ConvertFrom-Json).planHash
# Registers/runs exactly one canonical read-only recovery-plan task.
& $recoveryPython $recoveryOperator run --mode setup-recovery-plan @recoveryCommon --input $recoveryPlanInput --input-sha256 $recoveryPlanInputHash --plan $recoveryTaskPlan --plan-sha256 $recoveryTaskPlanHash --confirm RUN_ONE_REVIEWED_CASE01_TASK --out "$recoveryRoot\case01-recovery-plan-execution.json"
if ($LASTEXITCODE -ne 0) { throw 'Recovery plan task requires reconciliation; do not replay.' }
```

After the actual plan execution is `VERIFIED`, owner exit0, inspect its fresh source-owned plan. Materialize the fixed execute input and prepare the one-shot execute task:

```powershell
$recoveryOwnerPlanHash = (Get-FileHash -Algorithm SHA256 -LiteralPath "$recoveryRoot\case01-recovery-plan-execution.json").Hash.ToLowerInvariant()
& $recoveryPython $recoveryOperator materialize-execute-input --mode setup-recovery-execute --owner-plan-execution-sha256 $recoveryOwnerPlanHash
if ($LASTEXITCODE -ne 0) { throw 'Recovery execute input refused.' }
$recoveryExecuteInput = "$recoveryRoot\case01-recovery-execute-input.json"
$recoveryExecuteInputHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $recoveryExecuteInput).Hash.ToLowerInvariant()
# Read-only AWS preparation; verifies the prior actual task, definition, digest,
# exact override and CloudWatch owner plan before accepting its authority.
& $recoveryPython $recoveryOperator prepare --mode setup-recovery-execute @recoveryCommon --input $recoveryExecuteInput --input-sha256 $recoveryExecuteInputHash --out "$recoveryRoot\case01-recovery-execute-task-plan.json"
if ($LASTEXITCODE -ne 0) { throw 'Recovery execute preparation refused.' }
```

Inspect the prepared execute task, then submit once:

```powershell
$recoveryExecutePlan = "$recoveryRoot\case01-recovery-execute-task-plan.json"
$recoveryExecutePlanHash = (Get-Content -LiteralPath $recoveryExecutePlan -Raw | ConvertFrom-Json).planHash
& $recoveryPython $recoveryOperator run --mode setup-recovery-execute @recoveryCommon --input $recoveryExecuteInput --input-sha256 $recoveryExecuteInputHash --plan $recoveryExecutePlan --plan-sha256 $recoveryExecutePlanHash --confirm RUN_ONE_REVIEWED_CASE01_TASK --out "$recoveryRoot\case01-recovery-execute-execution.json"
if ($LASTEXITCODE -ne 0) { throw 'Recovery outcome requires reconciliation; preserve all files and never resend automatically.' }
```

Every mutation has exclusive local intent/acknowledgment receipts; the database owner atomically checks the fresh tenant settings, original claim and exact pending source before claiming recovery. Stale scope/settings, service/source drift, unknown registration/run acknowledgment, timeout or partial owner failure stops and preserves evidence. Do not replace output files or locks to retry. A successful setup is still `liveAcceptance: NOT_RUN`, with projection recorded but not qualified. Provider budget installation, authenticated case01 capture and grading remain separate gates.
