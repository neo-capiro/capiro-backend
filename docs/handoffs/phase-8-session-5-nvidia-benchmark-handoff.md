# Phase 8 Session 5 — NVIDIA real-Batch handoff

## Verdict

**SESSION5_P0_RUNTIME_ACCEPTED_LIVE_CORPUS_BLOCKED**

Do **not** redeploy the benchmark stack or submit a paid NVIDIA TransformJob yet.

A real-runtime review found that the earlier provider-ready implementation was still simulation-oriented. The separate `nvidia_real_batch_v2` path passed the final local runtime/CDK re-review at local head `858939ba1fc4a8e6a88bf298a0f2b4f07c2682c1`. No live NVIDIA benchmark is claimed. The remote PR head remains `53e80207b8dcbda209905205953c3bc3dbdfe893` because no push was performed in this assignment.

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

Known blockers remain:

- scanned/image-only: missing source-grounded gold;
- R-2 and Navy BA6: incomplete/conflicted;
- P-1 and O-1/OP-5: missing accepted normalized artifacts;
- remaining strata need re-review;
- separate live NVIDIA table-structure and OCR provider packages are not configured; those are comparison intents, not current provider implementations.

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

An earlier implementation milestone passed an isolated **15/15** P0 test harness, but the branch was tightened afterward with strict live-gold, provider-identity, and payload-size changes. **Do not treat 15/15 as current-tip acceptance.** The final Session 5 suite passed **34/34**, and the isolated CDK suite passed **6/6**.

Likewise, pre-P0 Session 2/3/4 DB/Docker results were real at the time but do not validate this materially changed tip. The final Session 2/3 DB rehearsal integration phases still failed in the same four defense-api integration files; those are retained as explicit baseline/environment blockers rather than reported as green.

The current GitHub Actions run is repository-level `startup_failure` before jobs execute. Therefore a clean Linux/Docker runner must rerun the full gate set below before deployment is reconsidered.

## Required clean re-review before redeploy

```bash
pnpm install --frozen-lockfile
pnpm --filter @capiro/defense-contracts build
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

The correct verdict is `SESSION5_P0_RUNTIME_ACCEPTED_LIVE_CORPUS_BLOCKED`.

Next action: prepare/approve source-grounded gold, then separately request authorization for an isolated observational/live run. Do not deploy the stack, submit a paid TransformJob, create an evidence file, or start Session 6 here.
