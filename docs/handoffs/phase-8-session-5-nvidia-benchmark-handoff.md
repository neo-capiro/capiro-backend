# Phase 8 Session 5 — NVIDIA Async Inference handoff

## Current verdict

**SESSION5_ASYNC_RUNTIME_READY_AWAITING_LIVE_RUN_AUTHORIZATION**

The replacement async execution adapter is implemented and locally independently re-reviewed. No endpoint was created and no async invocation was submitted in this assignment. The live benchmark remains explicitly unauthorized.

## Exact coordinates

- Repository: `neo-capiro/capirov2`
- Branch: `agent/phase8-session5-nvidia-benchmark`
- Last implementation baseline before this adapter: `eb72e95c4a7f9902b2e9dc95207b3618d5259964`
- AWS account/region: `967807252336` / `us-east-1`
- Pinned Marketplace package: `arn:aws:sagemaker:us-east-1:865070037744:model-package/nvidia-nemotron-parse-6673990e627d314f8aceb69f5e816587`
- Model/version: `nemotron-parse` / `LLM NIM 1.14 and VLM NIM version 1.5.0`
- Frozen corpus SHA: `a4bf213ea908f6dff2988e1ec3c78d0d5359a8e085554cb1915721b687fc8e98`
- Parser options SHA: `890f08082befbee5261b4c77f0646d647a98d402bfd31c0dcb022f2610cf688a`
- Rendering config SHA: `800a38fb9e8a4f8e014febe9822a5ca075596cf03d8544ab2aa67d9856f8a2fc`
- Corpus: 8/8 accepted, 0 blocked, 10 prepared pages

## Hosting preflight

The exact `DescribeModelPackage` result reported:

- `ModelDataSource`: present, with the pinned NVIDIA manifest S3 prefix
- `SupportedContentTypes`: `application/json`
- `SupportedResponseMIMETypes`: `application/json`
- `SupportedRealtimeInferenceInstanceTypes`: includes `ml.g5.xlarge`
- `SupportedTransformInstanceTypes`: includes `ml.g5.xlarge`, but this does not override the ModelDataSource Batch restriction
- Marketplace product: `prod-jpaccpvt6aut4`
- Container digest: `sha256:df067fc805581e2d1bfee3da87b5fe437115927098d931e48a162b70d51a5615`
- `CertifyForMarketplace`: `true`

The prior live Batch retry was rejected by SageMaker with:
`SageMaker Batch currently doesn't support Model entity with container definitions which use ModelDataSource attribute`.
No Batch Transform retry is permitted.

The exact realtime-hosting instance support makes Async Inference the compatible replacement candidate. This is a capability proof from the package metadata, not live async execution evidence.

## Async lifecycle

The active runtime is `sagemaker_async_inference`:

`CAPACITY_RESERVED -> ENDPOINT_CREATING -> ENDPOINT_READY -> REQUESTS_SUBMITTED -> REQUESTS_RECONCILING -> ARTIFACT_VERIFIED -> COMPLETION_PENDING -> RESUME_PUBLISHED -> ENDPOINT_DRAINING -> ENDPOINT_DELETED -> COMPLETE`

The endpoint and endpoint config are orchestrator-owned and deterministic. The CDK construct creates the pinned isolated model/control plane only; it does not create a persistent endpoint. Existing endpoint/config identities are rediscovered and checked before reuse. Orphaned deterministic resources refuse a new reservation until reconciled.

- Endpoint names derive from the corpus SHA, exact package ARN, model/version, runtime contract, endpoint configuration, output/failure locations, instance type, execution role, and KMS identity. Async inference IDs derive from endpoint identity, source/page, payload SHA, and attempt.

## Zero-idle and crash recovery

- Endpoint variant autoscaling: `MinCapacity=0`, `MaxCapacity=1`
- Explicit delete is still mandatory after completion or failure
- Hard endpoint lifetime: `NVIDIA_MAX_ENDPOINT_LIFETIME_SECONDS`, default 1,800 seconds
- Watch/reconcile discovers an endpoint after local state loss
- CreateEndpoint uncertainty is resolved by deterministic rediscovery
- Endpoint/config deletion is idempotent for not-found responses
- Endpoint config is deleted only after endpoint absence is observed
- `async-drain` and `async-zero-idle` are explicit operators' commands
- Zero-idle requires ledger active capacity zero and no Session 5 async endpoints

## Spend and provenance

The atomic DynamoDB ledger reserves the maximum bounded endpoint wall-clock cost before endpoint creation. With the current test rate assumptions (USD 1 Marketplace + USD 1 instance/hour) and 1,800-second lifetime, the projection is USD 1.00. Actual settlement is derived from observed endpoint timestamps after endpoint and config deletion; caller-provided cost is not accepted. USD 150 remains unavailable unless extended authorization is explicitly set; current effective cap is USD 50.

Each async invocation binds source SHA, physical page, rendered PNG SHA, provider payload SHA, rendering SHA, model/version, endpoint identity, deterministic inference ID, exact S3 output location, raw output SHA, and normalized output SHA through an immutable sidecar.

## IAM and CDK

The isolated orchestrator role now has only the Async Inference lifecycle actions, `InvokeEndpointAsync`, scoped role passing to the model execution role, the exact DynamoDB/S3/SQS/KMS controls, and the bounded autoscaling actions. `CreateTransformJob`, `DescribeTransformJob`, `StopTransformJob`, and related Batch execution permissions were removed from the active role. No production DB, Clerk, snapshot, canonical, routing, EventBridge, or unrelated IAM permissions were added.

## Validation at this worktree

- Full Session 5 Node suite: 59/59 passed at final commit `659de0fbc`
- Async-specific tests: 17/17 passed within that suite
- Real-runtime containment tests: 7/7 passed within that suite
- Final audit repair commits `13f7d6266`, `53d90f969`, `678f15a3b`, and `659de0fbc` are pushed to the branch
- P0 verifier: `SESSION5_P0_RUNTIME_PASS`
- Corpus verifier: `SESSION5_CORPUS_READY_PASS accepted=8 blocked=0`
- Async CDK-focused tests: 6/6 passed
- Defense contracts build: passed
- Async/CDK typecheck: passed
- Session 2 DB rehearsal: 36 checks passed
- Session 3 parity: 52/52 passed
- Session 3 DB rehearsal: 86 checks passed
- Session 4 enforced replay: `SESSION4_SOURCE_PARITY_PASS`
- Docker containment: `SESSION4_IMAGE_CONTAINMENT_PASS (8 checks)`

- The current audit repair set is not yet committed or pushed. Do not claim `SESSION5_COMPLETE`; no provider output, score, accepted live benchmark evidence, or live zero-idle run exists.

## No-deployment boundary

- No endpoint created in this assignment
- No `InvokeEndpointAsync` submitted
- No GPU spend incurred
- No Batch Transform retry
- No alternative model/package/container
- No BYOC/NGC/ECR
- No production or shared DB/data/routing/default/EventBridge/snapshot/canonical mutation
- PR #1069 remains unmerged
- Session 6 not started

Live authorization must explicitly permit creating the deterministic async endpoint and invoking the frozen 10-page corpus before any paid AWS command is run.

## Prior Batch attempt retained

The previously performed isolated Batch attempt remains factual: quota was initially zero, quota was approved to one, Batch Transform created zero jobs, paid GPU spend was USD 0, active jobs were zero, endpoints were zero, and the reservation ledger ended at activeJobs zero and spentAndReservedUsd zero. Its ModelDataSource incompatibility is the reason the active adapter is now Async Inference.


Runtime safety verdict remains **SESSION5_P0_RUNTIME_ACCEPTED_LIVE_CORPUS_BLOCKED**. The source-grounded corpus is now accepted, but live execution is still separately unauthorized. Do **not** deploy the benchmark stack or submit a paid NVIDIA TransformJob.

A real-runtime review found that the earlier provider-ready implementation was still simulation-oriented. The separate `nvidia_real_batch_v2` path passed the local runtime/CDK re-review before corpus closeout. No live NVIDIA benchmark is claimed. The current corpus-closeout commit is `fac3c1fb21dfd4b02fe3c7cf316eaf45b99df8d7`.

## Coordinates and authorization

- Repository: `neo-capiro/capirov2`
- Base: `agent/phase8-session4-after-s3` @ `a5094361f9da82e70090f73da46b11108e6a8b45`
- Branch: `agent/phase8-session5-nvidia-benchmark`
- Draft PR: #1069
- AWS account/region: `967807252336` / `us-east-1`
- Marketplace package: `arn:aws:sagemaker:us-east-1:865070037744:model-package/nvidia-nemotron-parse-6673990e627d314f8aceb69f5e816587`
- Marketplace/model version: `LLM NIM 1.14 and VLM NIM version 1.5.0`
- Supported live instance verified earlier: `ml.g5.xlarge`
- Initial benchmark cap: **USD 50**
- Hard incremental ceiling: **USD 150**
- Max concurrent GPU jobs: **1**
- Routing: `benchmark`
- Benchmark accepted: `false`

## P0 corrections implemented

### Real provider contract

- SageMaker input/output MIME is `application/json`; line-oriented JSON records use `SplitType=Line` / `AssembleWith=Line`.
- Provider-native requests contain only the Nemotron Parse payload.
- Internal source/model/render/cache provenance lives in an immutable hashed sidecar, not in fabricated provider output.
- Real `.out` JSONL is joined to that sidecar and normalized into Capiro-owned v2 artifacts.
- Raw provider response SHA, sidecar SHA, normalized content SHA, source SHA, physical page, model/version/options and rendering identity are verified before cache/resume.

### Nemotron payload boundary

- live model: `nvidia/nemotron-parse`;
- PNG/base64 `image_url`;
- `markdown_bbox` tool;
- `temperature: 0.0`;
- explicit rendering config with renderer/version/DPI;
- rendered-image SHA + provider-payload SHA + rendering-config SHA;
- no arbitrary default 2,000-token truncation;
- provider record refuses before submission when it exceeds the bounded payload-size limit.

### Requested route vs actual provider

The existing benchmark vocabulary contains desired table/OCR lanes, but the currently subscribed live Marketplace provider is Nemotron Parse. The v2 identity therefore records separately:

- `requestedParserMethod`: governed route intent, such as table-structure or OCR;
- `parserMethod`: provider that actually executed; currently `nemotron_parse`.

A real Nemotron run may not be reported as a distinct table-structure/OCR provider result.

### Reconciliation / recovery

- CLI adds `reconcile --job-id`, `reconcile --all`, `retry`, and `watch`.
- `handle-event` accepts only a job ID; caller-supplied provider status/cost/output is not trusted.
- reconciliation re-reads SageMaker status/timestamps;
- watchdog requests `StopTransformJob` after the configured limit but does not settle/release spend until SageMaker is terminal;
- PLANNED/RESERVED/MANIFEST states are recoverable after crash;
- TransformJob names are deterministic from immutable batch identity + paid attempt.

### Completion outbox / DLQ

- CDK creates a dedicated FIFO completion queue and grants send permission;
- state machine uses `ARTIFACT_VERIFIED -> COMPLETION_PENDING -> RESUME_PUBLISHED`;
- completion publication is retryable;
- exhausted completion publication moves to the durable DLQ path;
- DLQ publication failure is itself persisted/retried.

### Atomic spend and concurrency

- CDK adds encrypted/PITR DynamoDB reservation ledger;
- reservation creation + control-row update occur in one transaction;
- transaction enforces active-jobs limit and spent+reserved capacity;
- initial effective spend cap is **USD 50**;
- use of the **USD 150** ceiling requires explicit `NVIDIA_EXTENDED_BUDGET_AUTHORIZED=true`;
- code refuses any hard cap above 150;
- terminal cost is reconciled from SageMaker provider timestamps plus configured infrastructure/Marketplace rates, never caller input;
- runtime emits `NvidiaActiveGpuJobs` and `NvidiaMonthlySpendUsd`.

### Cache / idempotency

v2 cache identity binds:

- source SHA / physical page;
- requested route intent / actual parser method;
- model name/version;
- parser-options hash;
- rendered-image SHA;
- exact provider-payload SHA;
- rendering-config SHA;
- runtime-contract version.

Cache body hash, identity and key are checked before reuse. Provider job identity contains no timestamp.

### FY27 gold acceptance

The live CLI gate can require **scorable** source-grounded gold. Every accepted stratum must have:

- `reviewStatus=accepted`;
- source evidence SHA;
- immutable source SHA and physical page;
- no incomplete/conflicted flag;
- explicit identity/money/table assertion arrays;
- at least one scorable assertion;
- exact value/unit/FY/evidence-page identity for money assertions.

The eight required source-grounded strata are now accepted in the Session 5 corpus ledger. The remaining live boundary is authorization and provider availability:

- separate live NVIDIA table-structure and OCR provider packages are not configured; those are comparison intents, not current provider implementations;
- no live NVIDIA provider artifacts or accepted live benchmark evidence exist because execution is not authorized by this assignment.

A provider run may be observational, but model output may not be used to create its own acceptance gold.

## Changed surface

- `apps/defense-parser-orchestrator/src/real-batch*.mjs`
- `apps/defense-parser-orchestrator/src/aws-real-*.mjs`
- `apps/defense-parser-orchestrator/src/cli.mjs`
- `apps/defense-parser-orchestrator/scripts/materialize-live-inputs.mjs`
- `packages/defense-contracts/src/parser/nvidia-real-batch.ts`
- `infra/cdk/bin/phase8-session5-nvidia-benchmark.ts`
- `infra/cdk/lib/phase8-session5-nvidia-benchmark.ts`
- `infra/cdk/test/phase8-session5-nvidia-benchmark.spec.ts`
- Session 5 P0 unit tests and verifier
- live manifest/evidence schema/workflow/docs

The prior v1 simulation/scoring code remains for historical provider-ready coverage. The live CLI uses the v2 coordinator and ports.

## Validation truth

An earlier implementation milestone passed an isolated **15/15** P0 test harness, but the branch was tightened afterward with strict live-gold, provider-identity, and payload-size changes. **Do not treat 15/15 as current-tip acceptance.** The current Session 5 suite passed **40/40**, and the isolated CDK suite passed **6/6**.

The current clean validation reran the Session 2 DB rehearsal (36 checks), Session 3 DB rehearsal (86 checks), Session 3 parity (52/52), Session 4 enforced replay, and Docker containment successfully. These are current-tip results, not historical carry-forward.

The GitHub Actions startup-failure observation predates this corpus-closeout commit and is not treated as current local validation. A clean Linux/Docker runner should rerun the full gate set before deployment is reconsidered.

## Required clean re-review before redeploy

```bash
pnpm install --frozen-lockfile
pnpm --filter @capiro/defense-contracts build
node --test apps/defense-parser-orchestrator/test/*.test.mjs
node scripts/verify-phase8-session5.mjs
node scripts/verify-phase8-session5-corpus.mjs
node --check apps/defense-parser-orchestrator/src/session5.mjs
node --check apps/defense-parser-orchestrator/src/real-batch-config.mjs
node --check apps/defense-parser-orchestrator/src/real-batch-provider.mjs
node --check apps/defense-parser-orchestrator/src/real-batch-cost.mjs
node --check apps/defense-parser-orchestrator/src/real-batch-coordinator.mjs
node --check apps/defense-parser-orchestrator/src/aws-real-storage.mjs
node --check apps/defense-parser-orchestrator/src/aws-real-ledger.mjs
node --check apps/defense-parser-orchestrator/src/aws-real-runtime.mjs
node --check apps/defense-parser-orchestrator/src/cli.mjs
node --check apps/defense-parser-orchestrator/scripts/materialize-live-inputs.mjs
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
test "$(docker run --rm --entrypoint id capiro-defense-parser-orchestrator:phase8-session5 -u)" = '1001'
git diff --check
```

Then independently review the real provider path/CDK. Passing tests alone do not authorize redeploy.

## Deployment and live-completion gates

Redeploy becomes eligible only after the exact-tip clean gate set and re-review have no P0/P1 live-path issue.

`SESSION5_COMPLETE` remains impossible until the source-grounded gold corpus is accepted, real provider outputs are retained/scored, zero-idle is proven, and this genuinely passes:

```bash
PHASE8_SESSION5_LIVE_BENCHMARK_EVIDENCE=\
  docs/defense-budget/phase8-session5-live-benchmark-evidence.json \
node scripts/verify-phase8-session5.mjs --enforce-live-benchmark
```

Zero-idle evidence must include:

- atomic ledger `activeJobs = 0`;
- direct SageMaker Session 5 active TransformJobs = `[]`;
- persistent endpoints = `[]`;
- `zeroIdleGpu = true`.

## Scope statement

- Merge: **none**
- Redeploy after P0 discovery: **none**
- Paid NVIDIA work after P0 discovery: **none**
- Production/shared DB migration: **none**
- Production data mutation: **none**
- Production routing/default: **unchanged**
- Production schedules: **unchanged**
- Production IAM/secrets: **unchanged**
- Snapshot activation: **none**
- Canonical promotion: **none**
- Persistent NVIDIA endpoint: **none**
- Session 6: **not started**

The correct corpus verdict is `SESSION5_CORPUS_READY_AWAITING_LIVE_RUN_AUTHORIZATION`.

The runtime safety verdict remains `SESSION5_P0_RUNTIME_ACCEPTED_LIVE_CORPUS_BLOCKED` until a separately authorized live run produces retained provider evidence. Do not deploy the stack, submit a paid TransformJob, create a live evidence file, or start Session 6 here.
