# Budget setup after the verified case01 continuation

Prepared only. No budget inputs were materialized and no AWS, database, browser,
or provider calls were made during preparation. Parent owns all live execution.
Use `case01-continuation-budget-oneoff.py` (SHA256
`85771211089b7e8fd63d57f1d619132517b6ff2e316823aa671dabd4aab03748`).
The earlier recovery-based budget materializer and its inputs remain untouched.

The operator requires the exact completed continuation file
`case01-continuation-execute-execution.json`, its reviewed SHA256, and its
matching task plan. The file must be VERIFIED, mode setup-continuation-execute,
exit0, with the complete nineteen-entry canonical journal ending SETUP_COMPLETE.
Materialization reads its actual binding and physical source identifiers. It
cannot create those receipts or supply a database version from a guessed value.

Use SDK Python from the existing runbook and clean C-drive canonical main
`C:\dev\cap-meri-outcomes-validation`. The API must already serve the qualified
continuation image (tested combined source 823edc1110a02082a06a4ff90cbaaa71f83b4e15
or its code-identical release descendant). Both budget tasks and the completed
continuation must use the same exact source and image digest. The helper pins
the four reviewed continuation/enum source blobs and only permits docs-only
main advancement after the image source. It does not redeploy any service.
Orchestrator c22 and Web78ad are independently pinned by the capture operator.

All commands below are arguments to this new helper. Substitute only actual
reviewed file hashes and actual canonical planHash values; none are populated
in this runbook. Let ROOT be this directory, PROOF the new continuation-image
API one-off build proof, and PROOF_HASH its independently reviewed file hash.

1. Local only: `materialize-plan-input --mode budget-plan
   --continuation-execution-sha256 <actual completed continuation file hash>`.
   Creates ROOT\budget-plan-continuation-input.json exclusively. Zero AWS calls.
2. Read-only qualification: `prepare --mode budget-plan
   --repo C:\dev\cap-meri-outcomes-validation --proof PROOF
   --proof-sha256 PROOF_HASH --input ROOT\budget-plan-continuation-input.json
   --input-sha256 <actual input hash>
   --out ROOT\budget-plan-continuation-task-plan.json`.
   Revalidates the actual prior continuation task/TD/digest/command/exit/logs,
   current served API, source, roles and network before saving a task plan.
3. Root reviews the plan, then `run` with the same arguments plus
   `--plan ROOT\budget-plan-continuation-task-plan.json
   --plan-sha256 <actual planHash> --confirm RUN_ONE_REVIEWED_CASE01_TASK`
   and output ROOT\budget-plan-continuation-execution.json.
   This submits exactly one DB-read-only canonical budget-plan task. It creates
   no model turn, provider admission or business effect.
4. After VERIFIED exit0, local only: `materialize-install-input
   --mode budget-install --continuation-execution-sha256 <same completed hash>
   --budget-plan-execution-sha256 <actual budget-plan execution file hash>`.
   Creates ROOT\budget-install-continuation-input.json exclusively. It copies
   current source/binding/prior-qualification hashes and tenant xmin from the
   actual plan, requires no prior qualification, and never invents CAS values.
5. Prepare/review/run mode budget-install with that input and distinct outputs
   ROOT\budget-install-continuation-task-plan.json and
   ROOT\budget-install-continuation-execution.json. The same fixed confirmation
   applies. Qualification independently revalidates both preceding jobs' actual
   ECS/TD/log records. The source-owned installer repeats canonical owner and
   CAS checks transactionally before writing only the approved qualification.

The fixed reviewed rates allow case01 at most 3,000,000 cost micros ($3),
200,000 tokens and 32 provider attempts. These are ceilings, not additional
turn authorization. Existing aggregate slice admission remains separate.
The original rate file expires 2026-10-03T06:08:00Z; derive/install refuses when
less than thirty minutes remain. A successful install remains liveAcceptance
NOT_RUN. Neither setup mode sends a chat turn.

Successful final envelope: status VERIFIED, mode budget-install,
containerExitCode0, one ownerReceipts entry with
status PROVIDER_QUALIFICATION_INSTALLED, tenantId/clientId/captureRunId,
currentVerifySha256/captureBindingSha256/qualificationSha256,
priorQualificationSha256/tenantRowVersion, maxCostMicros/rateEvidenceSha256/
rateEvidenceExpiresAt and liveAcceptance NOT_RUN. Each field is joined to the
materialized input and actual current owner receipt. The aggregate-v4 operator
may copy the completed continuation and budget files byte-for-byte to its
`continuation-execute-execution.json` and `budget-install-execution.json` names,
then pin their actual hashes; no receipts are rewritten or synthesized.

Every file is exclusive, and every ECS submission retains its durable intent,
task identity and receipt. Any unknown acknowledgement, timeout, nonzero exit,
CAS conflict or incomplete receipt is RECONCILIATION_REQUIRED. Do not rerun,
overwrite files, clear claims, or generate a replacement plan to hide failure.
Readiness remains blocked until the real continuation and budget receipts exist.
