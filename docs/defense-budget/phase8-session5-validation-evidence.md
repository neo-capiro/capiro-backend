# Phase 8 Session 5 validation evidence

This file separates **pre-P0 historical evidence** from validation that actually covers the new real-Batch runtime.

## Current verdict

`SESSION5_P0_RUNTIME_IMPLEMENTED_RE_REVIEW_REQUIRED`

No redeploy or paid NVIDIA benchmark has been performed after the P0 real-runtime review.

## P0 issue that invalidated the prior provider-ready conclusion

The previous provider-ready gates did not prove that the SageMaker Batch path could safely execute against the real NVIDIA model package. Real-runtime review identified:

- unsupported `application/jsonlines` MIME on the provider path;
- an invented aggregate provider-output shape;
- no polling/reconciliation driver;
- no deployed completion queue/outbox;
- non-atomic spend/concurrency accounting and caller-supplied cost;
- timestamped paid-job identities and incomplete cache identity;
- insufficient accepted source-grounded gold to close the live benchmark.

Those are now implementation targets of the `nvidia_real_batch_v2` path rather than being waived.

## P0 changes now in branch

- provider MIME: `application/json` with `SplitType=Line` / `AssembleWith=Line`;
- provider-native request lines + immutable hashed Capiro input sidecars;
- JSONL `.out` normalization via `markdown_bbox` tool output;
- raw provider-response hash + normalized artifact hash;
- reconciliation commands that re-read SageMaker provider facts;
- timeout stop/watchdog with terminal-state settlement;
- durable `COMPLETION_PENDING` outbox and recoverable DLQ publication;
- deterministic TransformJob identity by immutable batch + paid attempt;
- v2 cache identity includes rendered-image, provider-payload and rendering-config hashes;
- cache body/identity/key validation before reuse;
- DynamoDB atomic concurrency/spend reservation ledger;
- USD 50 initial effective cap and USD 150 absolute ceiling;
- direct runtime emission of `NvidiaActiveGpuJobs` / `NvidiaMonthlySpendUsd`;
- CDK completion queue, DynamoDB ledger, correct IAM, and no endpoint resources;
- source-grounded gold preflight for all required strata.

## Fresh validation that DOES cover the P0 implementation

In the isolated implementation harness used to build the new modular path:

- modular Node syntax checks: **PASS**
- P0 real-Batch/AWS tests: **15/15 PASS**

Those tests cover:

- application/json + line split/assembly;
- deterministic provider job names/idempotent ensure;
- exact input-correlated `.out` resolution;
- atomic Dynamo reservation conditions;
- USD 50 / USD 150 authorization; max concurrency 1;
- expanded cache identity;
- real JSONL + sidecar normalization;
- rejection of incomplete/unaccepted gold;
- pre-submission crash recovery;
- SageMaker-timestamp cost reconciliation;
- completion-outbox failure/retry;
- DLQ publication failure/retry;
- zero-idle direct-provider cross-check;
- timeout stop without premature reservation release.

This isolated result is useful implementation evidence but is **not** the required clean-checkout repository acceptance sweep.

## Pre-P0 historical gates — do not treat as validating current tip

Before the P0 runtime rewrite, the agent had genuinely rerun and passed:

- Session 2 DB rehearsal: 36 checks;
- Session 3 parity: 52/52;
- Session 3 DB rehearsal: 86 checks;
- defense-api DB suite: 64/64;
- Session 4 source parity and enforced replay;
- no-cache orchestrator image and containment;
- focused Session 5 tests and CDK tests.

The branch has since changed materially. These results establish the prerequisite baseline only; they must be rerun before deployment.

## Required fresh re-review gate before redeploy

Run from a clean checkout of the exact current Session 5 SHA:

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

Then independently inspect the CDK and live provider path. Passing tests alone do not authorize redeploy.

## Current AWS/Marketplace facts already established

- Account: `967807252336`
- Region: `us-east-1`
- Exact package ARN: `arn:aws:sagemaker:us-east-1:865070037744:model-package/nvidia-nemotron-parse-6673990e627d314f8aceb69f5e816587`
- Listing/model version: `LLM NIM 1.14 and VLM NIM version 1.5.0`
- Marketplace package requires `EnableNetworkIsolation: true`
- authorized initial target: **USD 50**
- hard incremental ceiling: **USD 150**
- max concurrent GPU jobs: **1**
- routing: benchmark
- benchmark accepted: false

The earlier failed CloudFormation attempt occurred before GPU/model/job creation because network isolation was absent. The empty bucket/stack were removed; the unused KMS key was scheduled for deletion. No paid NVIDIA work occurred.

## Gold-corpus blocker

Even if the runtime passes re-review, `SESSION5_COMPLETE` cannot be asserted until accepted source-grounded gold covers all eight strata. Current manifest records the known gaps explicitly.

The live verifier must remain closed until a genuine evidence file exists:

```bash
PHASE8_SESSION5_LIVE_BENCHMARK_EVIDENCE=\
  docs/defense-budget/phase8-session5-live-benchmark-evidence.json \
node scripts/verify-phase8-session5.mjs --enforce-live-benchmark
```

No evidence file has been fabricated.

## Scope / mutation evidence

Since the P0 real-runtime blocker was identified:

- redeployed stack: **no**
- paid TransformJob: **no**
- persistent endpoint: **no**
- production routing/default change: **no**
- production/shared DB/data change: **no**
- production schedules: **no**
- snapshot activation: **no**
- canonical promotion: **no**
- Session 6: **not started**
