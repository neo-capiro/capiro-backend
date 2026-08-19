# Phase 8 Session 5 — NVIDIA benchmark and ephemeral GPU handoff

## Verdict

**SESSION5_P0_RUNTIME_IMPLEMENTED_RE_REVIEW_REQUIRED**

Do **not** redeploy the benchmark stack or submit a paid NVIDIA TransformJob yet.

A real-runtime review correctly found that the original Session 5 provider-ready layer was still simulation-oriented. The branch now contains a separate real Batch v2 path that closes those P0 implementation gaps, but the new code/CDK must receive a fresh full validation/review and the FY27 source-grounded gold corpus is still incomplete. No live NVIDIA benchmark is claimed.

## Repository coordinates

- Repository: `neo-capiro/capirov2`
- Base: `agent/phase8-session4-after-s3` @ `a5094361f9da82e70090f73da46b11108e6a8b45`
- Branch: `agent/phase8-session5-nvidia-benchmark`
- Draft PR: #1069
- Marketplace package: `arn:aws:sagemaker:us-east-1:865070037744:model-package/nvidia-nemotron-parse-6673990e627d314f8aceb69f5e816587`
- AWS account/region: `967807252336` / `us-east-1`
- Authorized initial benchmark cap: **USD 50**
- Authorized hard incremental ceiling: **USD 150**
- Maximum concurrent GPU jobs: **1**

## P0 gaps and implemented corrections

### 1. Provider input/output contract

Original defect:

- the real package accepts `application/json`, while the old adapter advertised `application/jsonlines`;
- raw provider output is line-oriented JSON but does not contain Capiro's internal source/model/hash fields;
- the old verifier expected an invented aggregate provider artifact.

Correction:

- real adapter now uses `ContentType=application/json`, `SplitType=Line`, `Accept=application/json`, `AssembleWith=Line`;
- each provider-native request line has a separately retained immutable hashed input sidecar;
- provider `.out` JSONL is parsed and joined back to the sidecar;
- `markdown_bbox` output is normalized into a Capiro-owned v2 artifact;
- raw provider response SHA, sidecar SHA, page identity and normalized content SHA are retained and verified.

NVIDIA's 1.5 API surface was cross-checked: `nvidia/nemotron-parse`, PNG/base64 `image_url`, `markdown_bbox`, and `temperature=0.0` are the request shape used by the materializer.

### 2. Reconciliation / terminal recovery

Original defect: `DescribeTransformJob` existed but was never driven; only a caller-fabricated event could finish a job.

Correction:

- CLI supports `reconcile --job-id`, `reconcile --all`, `retry`, and `watch`;
- `handle-event` is reduced to a job-id reconciliation signal and accepts no provider status/cost/output facts;
- reconciliation always re-reads SageMaker status/timestamps;
- watchdog requests `StopTransformJob` after the configured maximum but does not release/settle spend until SageMaker reaches a terminal state;
- pre-submission PLANNED/RESERVED/MANIFEST states are recoverable after process crash;
- deterministic TransformJob names make provider creation idempotent per paid attempt.

### 3. Completion queue / outbox

Original defect: runtime expected a completion queue but CDK did not create/export one; verified work could be stranded if completion publication failed.

Correction:

- CDK now creates a third FIFO `CompletionQueue` and grants orchestrator send permission;
- state machine has `ARTIFACT_VERIFIED -> COMPLETION_PENDING -> RESUME_PUBLISHED`;
- completion publication is retryable and persists the error/attempt count;
- exhausted completion publication moves through the durable DLQ path;
- DLQ publication failure itself is persisted (`dlqPublishPending`) and retried during reconciliation.

### 4. Atomic spend / concurrency control

Original defect: S3 latest-state counting is not atomic and caller-provided `actualCostUsd` was trusted.

Correction:

- CDK adds an encrypted/PITR DynamoDB reservation ledger;
- one transaction conditionally creates the reservation and updates a strongly consistent control row;
- the same transaction enforces max concurrent jobs and spent+reserved capacity;
- initial effective cap is **USD 50** by default;
- the **USD 150** ceiling requires explicit `NVIDIA_EXTENDED_BUDGET_AUTHORIZED=true`; neither code nor config can raise the hard ceiling above 150;
- reservation amount uses the maximum configured job duration and a conservative combined hourly-rate floor;
- terminal spend is reconciled from SageMaker timestamps plus configured infrastructure/Marketplace hourly rates, never from a caller event;
- runtime emits the exact alarm metric names `NvidiaActiveGpuJobs` and `NvidiaMonthlySpendUsd`.

### 5. Cache / idempotency

The v2 page identity now binds:

- source SHA;
- physical page;
- parser method;
- model name/version;
- parser-options hash;
- rendered-image SHA;
- exact provider-payload SHA;
- rendering-config SHA;
- runtime contract version.

Cache hits read the body and verify body SHA, identity, and cache key before reuse. A stale/corrupt object refuses instead of becoming a hit.

Provider job names are SHA-derived from immutable batch ID + explicit paid attempt number; no timestamp participates in provider identity.

### 6. FY27 gold-corpus acceptance

This remains a blocker rather than being hidden.

The live scorer now has an additional preflight `validateLiveBenchmarkCorpus` requirement: every required stratum must contain source-grounded gold with `reviewStatus=accepted`, a `sourceEvidenceSha256`, and no incomplete/conflicted flag.

Current known gaps recorded in the manifest:

- scanned/image-only: missing source-grounded gold;
- R-2 identity and Navy BA6: incomplete/conflicted;
- P-1 and O-1/OP-5: no accepted normalized artifact;
- other strata require re-review before live acceptance.

A provider run may be useful observationally, but it cannot be used to invent its own acceptance gold.

## New/changed implementation surface

- `apps/defense-parser-orchestrator/src/real-batch*.mjs`
- `apps/defense-parser-orchestrator/src/aws-real-*.mjs`
- `apps/defense-parser-orchestrator/src/cli.mjs`
- `apps/defense-parser-orchestrator/scripts/materialize-live-inputs.mjs`
- `packages/defense-contracts/src/parser/nvidia-real-batch.ts`
- `infra/cdk/lib/phase8-session5-nvidia-benchmark.ts`
- `infra/cdk/bin/phase8-session5-nvidia-benchmark.ts`
- `infra/cdk/test/phase8-session5-nvidia-benchmark.spec.ts`
- `apps/defense-parser-orchestrator/test/real-batch.test.mjs`
- `apps/defense-parser-orchestrator/test/aws-real-runtime.test.mjs`
- `scripts/verify-phase8-session5.mjs`

The old v1 simulation/scoring code remains intact for historical provider-ready coverage; the live CLI uses the v2 real Batch coordinator and ports.

## Validation state after P0 implementation

Fresh isolated Node validation of the intended P0 modules/tests completed in the implementation environment:

- real Batch/AWS P0 tests: **15/15 PASS**
- syntax checks for the modular v2 runtime: **PASS**

These are not a substitute for the required clean-repository gate sweep. Because the branch was changed materially after the previously reported Docker/DB/CDK passes, those older results must not be represented as validating the new P0 tip.

Before any redeploy or paid job, re-run at minimum:

```bash
pnpm install --frozen-lockfile
pnpm --filter @capiro/defense-contracts build
node --test apps/defense-parser-orchestrator/test/*.test.mjs
node scripts/verify-phase8-session5.mjs
pnpm --filter @capiro/infra-cdk typecheck
pnpm --filter @capiro/infra-cdk exec jest test/phase8-session5-nvidia-benchmark.spec.ts --runInBand

pnpm verify:phase8-session2
pnpm verify:phase8-session2:db
pnpm verify:phase8-session3
pnpm verify:phase8-session3:admin
pnpm verify:phase8-session3:parity
pnpm verify:phase8-session3:db

PHASE8_SESSION4_REPLAY_EVIDENCE=docs/defense-budget/phase8-session4-fy27-replay-evidence.json \
node scripts/verify-phase8-session4.mjs --enforce-replay

docker build --no-cache -f apps/defense-parser-orchestrator/Dockerfile \
  -t capiro-defense-parser-orchestrator:phase8-session5 .
git diff --check
```

Then perform a **code/CDK review** of the real provider path before approving deployment.

## Deployment gate

Do not deploy merely because the P0 unit tests pass.

Deployment becomes eligible only when:

1. P0 real-runtime code/CDK and full prerequisite gates pass on the exact branch SHA;
2. no P0/P1 live-path issue remains in review;
3. the initial observational corpus is explicitly labeled observational if accepted gold is not complete;
4. no claim of `SESSION5_COMPLETE` is possible until the eight accepted-gold strata and enforced live evidence gate are satisfied.

## Live completion gate

Only a genuine evidence file may pass:

```bash
PHASE8_SESSION5_LIVE_BENCHMARK_EVIDENCE=\
  docs/defense-budget/phase8-session5-live-benchmark-evidence.json \
node scripts/verify-phase8-session5.mjs --enforce-live-benchmark
```

Zero-idle evidence now requires all of:

- atomic ledger `activeJobs = 0`;
- direct SageMaker active Session 5 TransformJobs = `[]`;
- persistent endpoints = `[]`;
- `zeroIdleGpu = true`.

## Scope statement

- Merge: **none**
- New redeploy after P0 discovery: **none**
- Paid NVIDIA work after P0 discovery: **none**
- Production/shared DB migration: **none**
- Production data mutation: **none**
- ALB/ECS production routing: **none**
- EventBridge production schedules: **none**
- Production IAM/secrets: **none**
- Snapshot activation: **none**
- Canonical promotion: **none**
- Persistent NVIDIA endpoint: **none**
- Production parser default: **unchanged**
- Session 6: **not started**

The correct verdict remains `SESSION5_P0_RUNTIME_IMPLEMENTED_RE_REVIEW_REQUIRED` until fresh full validation and re-review are complete.
