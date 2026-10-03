# One original controlled read: case20 or case72

The operator composes the existing qualified API setup/budget owners and authenticated conversation API with `controlled-read-live-capture.mjs`. It needs no new backend route or release after the controlled-read implementation. Use only synthetic T1 Pat and the owned Aster client. Run one case at a time; preserve final current-source evidence before replacing the tenant fixture binding for the next case. Case21–24/26/27 and74 are refused by this operator.

This document and local input checks are not live proof. The collector requires fresh real AWS immutable build readback, current authenticated fixture/provider admission, actual tool/HTTP observations, settled provider accounting, and the saved HMAC-verified message. A screenshot or `CAPTURE_COMPLETE` alone is not original acceptance.

## Dynamic inputs before execution

Use a clean reviewed operator checkout on C drive. Its source can differ from the qualified API source only in these operator files, their test, this document and `docs/`. The runner checks the exact `operatorSourceSha` and that the API source is an ancestor. It refuses other source drift. Existing server/collector/fixture modules must match the qualified API source.

Prepare an operator packet outside Git with these initial fields:

```json
{
  "manifestPath": "C:/dev/cap-meri-foundation-evidence/private/meri-foundation-20260928.manifest.json",
  "caseId": "20",
  "clientId": "ACTUAL_OWNED_ASTER_UUID",
  "captureRunId": "NEW_UUID_V4"
}
```

The materializer reads the private manifest in process and emits only the ordinary synthetic identity required by the server owner. Do not print/copy the full manifest or inject privileged roles. The server rechecks active actor membership, owned tenant namespace, client visibility/wall grants, current run/binding and CAS fences. Source maps are derived from frozen definitions and actual setup receipts; do not type or edit them by hand.

Use a separate deployment JSON with the actual qualified API/orchestrator/Web sources and exact reviewed operator commit:

```json
{
  "apiSha": "QUALIFIED_API_40_HEX_SHA",
  "orchestratorSha": "QUALIFIED_ORCHESTRATOR_40_HEX_SHA",
  "webSha": "QUALIFIED_WEB_40_HEX_SHA",
  "operatorSourceSha": "REVIEWED_LOCAL_OPERATOR_40_HEX_SHA",
  "builds": {
    "api": {
      "service": "api",
      "sourceSha": "QUALIFIED_API_40_HEX_SHA",
      "imageDigest": "sha256:ACTUAL_64_HEX_DIGEST",
      "buildId": "capiro-build-web-dev:ACTUAL_BUILD_UUID",
      "buildspecSha256": "ACTUAL_64_HEX_BUILDSPEC_HASH"
    },
    "meriv2-orchestrator": {
      "service": "meriv2-orchestrator",
      "sourceSha": "QUALIFIED_ORCHESTRATOR_40_HEX_SHA",
      "imageDigest": "sha256:ACTUAL_64_HEX_DIGEST",
      "buildId": "capiro-build-web-dev:ACTUAL_BUILD_UUID",
      "buildspecSha256": "ACTUAL_64_HEX_BUILDSPEC_HASH"
    }
  }
}
```

The placeholders are intentionally invalid. Use the current successful build/promotion receipts. Mixed immutable source revisions are allowed only when actually qualified; no old-head build substitutes. Fresh live AWS readback independently requires exact digests, running completed service/task configuration, healthy targets and source metadata. The browser additionally requires `os.capiro.ai`, `vnext`, exact Web release SHA and canonical Clerk host.

Rates must be reviewed and unexpired for the full policy lifetime. The current source accepts the exact paired limits3USD/200,000 tokens or15USD/500,000 tokens,32 provider attempts, one synthesis and concurrency1. Select the reviewed pair before fixture/budget qualification; remaining aggregate funds do not authorize changing that qualified pair. Missing rates reject before dispatch. Provider endpoint, service-tier and billable-unit exclusions require separate qualification of the exact served candidate; this guide does not establish those protections. Unknown usage and unsettled costs cannot pass.

### Existing fresh journal on this machine

For the already authorized2026-10-03 fresh slice, use the separately reviewed `adoptExistingFreshCaptureSpend` adapter from `capture-spend-aggregate.mjs`. It reads the fixed existing `C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl` and exact authorization file; it creates no new owner, ledger or sidecar. The original20 events/five settled attempts retain$9.841281 charged and$20.158719 remaining under the original$30 aggregate/$15 per-case/concurrency1 limits. Older unresolved spending is separate and is not reset or replaced.

```javascript
const checkpoint = adoptExistingFreshCaptureSpend({
  pythonExecutable: 'C:/Users/neoma/AppData/Local/hermes/hermes-agent/venv/Scripts/python.exe',
});
```

This initial read is accepted only while the journal has exactly its pinned20-event prefix and no new reservation. Save the returned checkpoint durably outside Git. After any append, use the exact latest returned checkpoint; initial adoption is no longer allowed. This adapter admits native01/20 only. Case72 requires its own already qualified aggregate authority and cannot use this adapter. [Source and local tests](../../../docs/meri/releases/2026-10-03/c2-fresh-spend-adapter/README.md) do not establish live adoption or capture.

Pass the saved checkpoint path as `aggregateCheckpointPath` in the materializer packet. The native helper reopens ancestor/file identities, verifies all bytes and holds the journal's writer lock. Stale, replaced, missing, partial, duplicate, active or uncertain state blocks. The runner reserves the full configured case ceiling and flushes `aggregate-reserved-checkpoint.json` before authentication, conversation creation or synthesis. Canonical fixture/current-build/rate qualification is still required independently.

Only the existing authenticated same-process capture outcome can settle a new reservation and release its unused ceiling. The collector saves `aggregate-spend-checkpoint.json` and the runner saves `aggregate-final-checkpoint.json`; pass the exact latest checkpoint to the next serial case. Interrupted reservations retain their full ceiling. Do not fabricate settlement, re-adopt an active owner, refund, retry an uncertain capture, or create a replacement journal. Native UNIT settlement tests are not live evidence.

The historical original aggregate and its first run `c6ffa5ad-dd9f-4912-bc31-a03231a9b903` remain separate. `initializeCaptureSpendAggregate` is not a recovery path for that missing/uncertain history and must not replace the existing fresh journal. The current runner uses the local Python executable tested by the native NTFS adapter; Playwright remains at `C:/dev/node_modules/playwright`.

## Source-owned setup sequence

In the clean operator checkout, run the materializer with an absolute packet path and a new absolute output path:

```powershell
node evals/meri/live-v1/materialize-controlled-read.mjs setup-plan --packet C:/evidence/case20/packet.json --out C:/evidence/case20/setup-plan-input.json
```

Here `C:/evidence/...` stands for the operator's actual owned evidence directory. Materialization is local only. Then use the reviewed controlled-read one-off task runner with the qualified API image and its current private environment to execute exactly:

```text
node apps/api/scripts/meri-controlled-read-setup.mjs plan --input-env MERI_CONTROLLED_READ_SETUP_INPUT --out /tmp/controlled-plan.json
```

**Historical, unavailable wrapper:** the78ad image lacked a dedicated `meri-controlled-read-setup` dispatcher verb. Its old3USD-only sibling operator was `C:/dev/cap-meri-foundation-evidence/oct02-controlled-read/controlled-read-oneoff.py`; that file is absent on this machine and is not qualified for the current15USD path. The commands below retain its historical mode/input contract, not executable current instructions. A replacement bounded operator must first be reviewed against the exact candidate, current paired limits and actual CLI packaging. It must use only the canonical DB composer and fixed setup/budget entry points, DB secret references, exact image/source/configuration fences and actual exit/owner receipts. It must not import an old approval or fabricate a successful wrapper.

The runner is a narrow derivative of the reviewed case01 one-off operator, with a separate family/container, fixed20/72 setup schema/marker, explicit3USD qualification and no retry. Local19-test qualification and separate review are required before root execution. `prepare` is read-only; `run` is the sole authorized one-task mutation. Use:

```text
python C:/dev/cap-meri-foundation-evidence/oct02-controlled-read/controlled-read-oneoff.py prepare --mode setup-plan --repo C:/dev/cap-meri-outcomes-validation --proof ABSOLUTE_API_QUALIFICATION_JSON --proof-sha256 ACTUAL_PROOF_FILE_SHA256 --input ABSOLUTE_MATERIALIZED_INPUT_JSON --input-sha256 ACTUAL_INPUT_FILE_SHA256 --out C:/dev/cap-meri-foundation-evidence/oct02-controlled-read/case20-setup-plan-operation.json
python C:/dev/cap-meri-foundation-evidence/oct02-controlled-read/controlled-read-oneoff.py run --mode setup-plan --repo C:/dev/cap-meri-outcomes-validation --proof ABSOLUTE_API_QUALIFICATION_JSON --proof-sha256 ACTUAL_PROOF_FILE_SHA256 --input ABSOLUTE_MATERIALIZED_INPUT_JSON --input-sha256 ACTUAL_INPUT_FILE_SHA256 --plan C:/dev/cap-meri-foundation-evidence/oct02-controlled-read/case20-setup-plan-operation.json --plan-sha256 ACTUAL_PLAN_HASH_FIELD --confirm RUN_ONE_REVIEWED_CONTROLLED_READ_TASK --out C:/dev/cap-meri-foundation-evidence/oct02-controlled-read/case20-setup-plan-execution.json
```

For any qualified replacement, prepare/run each distinct next mode (`setup-execute`, `budget-plan`, `budget-install`) with that mode's newly materialized input, new operation/output names and actual hashes. The repository must be clean and its reviewed source must match origin/main, with only documented operator/doc drift from the image source; the prepared SHA, image/service/config baseline, task request, input and reviewed helper hashes must be fenced again before writes. Never reuse a plan across modes or drift.

Its environment input is the exact materialized JSON. Preserve the one-off execution receipt, container exit and emitted owner receipt. The materializer consumes the established wrapper format `{status:"VERIFIED",containerExitCode:0,ownerReceipts:[receipt]}` (or an entry with `.receipt`); it rejects failure, missing or multiple receipts. Do not manufacture this wrapper from a guess or a task submission acknowledgment.

Extend the local packet with `inputPath` pointing to `setup-plan-input.json` and `setupPlanPath` pointing to that actual verified execution. Then:

```powershell
node evals/meri/live-v1/materialize-controlled-read.mjs setup-execute --packet C:/evidence/case20/packet.json --out C:/evidence/case20/setup-execute-input.json
```

Execute in the same qualified API image:

```text
node apps/api/scripts/meri-controlled-read-setup.mjs execute --input-env MERI_CONTROLLED_READ_SETUP_INPUT --out /tmp/controlled-execute.json
```

Set `setupReceiptPath` to its actual verified execution receipt. The owner atomically replaces only the controlled locator/capture binding, records reset/seed receipts and invalidates previous rate qualification. Zero shared corpus writes are claimed and checked; other tenant settings remain intact. Never repeat execute after an ambiguous task result—reconcile read-only first.

Next materialize and execute the existing rate-owner plan (no conversation is required yet):

```powershell
node evals/meri/live-v1/materialize-controlled-read.mjs budget-plan --packet C:/evidence/case20/packet.json --out C:/evidence/case20/budget-plan-input.json
```

```text
node apps/api/scripts/meri-capture-provider-budget.mjs plan --input-env MERI_CAPTURE_PROVIDER_BUDGET_INPUT --out /tmp/controlled-budget-plan.json
```

Set `budgetPlanPath` to that verified execution and `reviewedRatesPath` to the current reviewed rate evidence. Then:

```powershell
node evals/meri/live-v1/materialize-controlled-read.mjs budget-install --packet C:/evidence/case20/packet.json --out C:/evidence/case20/budget-install-input.json
```

```text
node apps/api/scripts/meri-capture-provider-budget.mjs install --input-env MERI_CAPTURE_PROVIDER_BUDGET_INPUT --out /tmp/controlled-budget-install.json
```

Set `budgetInstallInputPath`, `budgetInstallReceiptPath` (the actual verified execution), `deploymentPath` and `aggregateCheckpointPath` (the exact latest native checkpoint). Then:

```powershell
node evals/meri/live-v1/materialize-controlled-read.mjs live-scope --packet C:/evidence/case20/packet.json --out C:/evidence/case20/live-scope.json
```

This input deliberately has `conversationId:null`. No invented UUID is accepted as an existing conversation.

## One authenticated creation and one capture

Inject the existing approved Clerk key only into this process's `CLERK_SECRET_KEY` environment through the operator's private credential mechanism. Never put it in a command line, packet, log or Git. The runner immediately removes it from the child-process environment and holds it in memory. Playwright/Python paths follow the current Windows machine map. Run once:

```powershell
node evals/meri/live-v1/run-controlled-read.mjs --execute-original-controlled-read-once --scope C:/evidence/case20/live-scope.json --manifest C:/dev/cap-meri-foundation-evidence/private/meri-foundation-20260928.manifest.json --out C:/evidence/case20/capture
```

The output directory must not exist. A durable per-case/run claim under `C:/dev/cap-meri-foundation-evidence/controlled-read-claims` also prevents changing output directories to retry. The runner verifies the real Clerk instance, fixture user/org metadata, one ordinary membership and deployed Web; creates one120-second sign-in ticket; and verifies the active exact actor/org. Browser application writes are blocked.

Native authenticated HTTPS verifies `/api/me`, API health/source and live immutable build identity, then persists a creation intent before one `POST /api/clio/conversations` with only the owned client and fixed namespace/case/run title. It reads the exact returned conversation and messages, requiring correct actor/tenant/client/title, no archive, no messages and no old provider ledger. Any timeout or ambiguous creation response stops for read-only reconciliation. There is no automatic retry, deletion or second synthesis.

After actual creation, the existing collector independently repeats current build/fixture/budget admission checks and submits the frozen original row prompt once. It captures actual receipts and source viewer evidence, grades deterministic checks while the process-owned capability is alive, and saves an assistant-only screenshot. The temporary session is revoked and revocation read back in `finally`; browser cleanup failures also block success. Only a SHA256 of the newly created session ID is recorded. After an interruption, an authorized recovery operator can compare this hash against private Clerk session readback for the same synthetic user and revoke only the exact match. No session ID, token or browser auth state is saved. Never revoke another session based on a diff or guess.

`CAPTURE_AND_DETERMINISTIC_PASS` still leaves original human rubric acceptance NOT_RUN. Review the actual answer/source/UI against the five0–2 dimensions; do not synthesize scores. Row72 requires actually observed identical logical failures and native `no_progress` suppression. An earlier model stop is a row failure, not permission to submit extra turns. Full File01 acceptance remains false.

Commit only sanitized summaries/reviews and explicitly screened synthetic artifacts. Exclude private manifest, environment/auth material, session handles, browser state and unscreened execution directories. Preserve failed claims/intents and earlier evidence for reconciliation.
