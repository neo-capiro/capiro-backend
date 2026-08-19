# Phase 8 Session 5 validation evidence

This file separates **historical evidence** from validation that actually applies to the current real-Batch implementation.

## Current verdict

`SESSION5_P0_RUNTIME_ACCEPTED_LIVE_CORPUS_BLOCKED`

Do **not** redeploy the isolated benchmark stack or submit a paid NVIDIA TransformJob yet.

No redeploy or paid NVIDIA benchmark has been performed after the P0 real-runtime review. The final local runtime/CDK review passed at `858939ba1fc4a8e6a88bf298a0f2b4f07c2682c1`.

## Final exact-tip re-review

Remote state was fetched first. The remote Session 5 head remained `53e80207b8dcbda209905205953c3bc3dbdfe893`; local fixes were committed at `858939ba1fc4a8e6a88bf298a0f2b4f07c2682c1` and were not pushed during this assignment.

- `pnpm install --frozen-lockfile`: PASS;
- shared/auth/defense-contracts/defense-domain/defense-client builds: PASS;
- all listed Node syntax checks: PASS;
- Session 5 Node tests: **34/34 PASS**;
- `node scripts/verify-phase8-session5.mjs`: PASS (`SESSION5_P0_RUNTIME_PASS`);
- CDK typecheck: PASS;
- isolated Session 5 CDK Jest: **6/6 PASS**;
- clean no-cache Docker build: PASS;
- image containment: PASS (`1001`, no exposed ports, no CUDA/NVIDIA device/static credentials/database/Clerk secrets, CLI reconciliation commands present);
- Session 2 boundary: PASS; Session 3 boundary/admin/parity: PASS, parity **52/52**; Session 4 enforced replay: PASS (`SESSION4_SOURCE_PARITY_PASS`).

The Session 2 DB and Session 3 DB rehearsals reached their disposable PostgreSQL integration suites but failed in the same four defense-api integration files: `health.service.integration.spec.ts`, `programs-admin-security.integration.spec.ts`, `programs.service.integration.spec.ts`, and `promotion/manual-override-repository.integration.spec.ts`. These remain explicit environment/baseline blockers and are not reported as passes. No production database was touched.

## Why the prior provider-ready conclusion was insufficient

The previous provider-ready gates did not prove that the SageMaker Batch path could safely execute against the real NVIDIA model package. Real-runtime review identified:

- unsupported `application/jsonlines` MIME on the provider path;
- an invented aggregate provider-output shape;
- no polling/reconciliation driver;
- no deployed completion queue/outbox;
- non-atomic spend/concurrency accounting and caller-supplied cost;
- timestamped paid-job identities and incomplete cache identity;
- provider identity that could label a real Nemotron Parse run as a separate table/OCR provider;
- insufficient accepted source-grounded gold to close the live benchmark.

Those are implemented as a separate `nvidia_real_batch_v2` path rather than waived.

## P0 changes now in branch

- provider MIME: `application/json` with `SplitType=Line` / `AssembleWith=Line`;
- provider-native request lines + immutable hashed Capiro input sidecars;
- JSONL `.out` normalization via `markdown_bbox` tool output;
- raw provider-response hash + normalized artifact hash;
- requested route intent retained separately from the actual provider identity;
- current live provider truthfully recorded as `nemotron_parse` for the subscribed Nemotron package;
- reconciliation commands that re-read SageMaker provider facts;
- timeout stop/watchdog with terminal-state settlement;
- durable `COMPLETION_PENDING` outbox and recoverable DLQ publication;
- deterministic TransformJob identity by immutable batch + paid attempt;
- v2 cache identity includes requested/actual method, rendered-image, provider-payload and rendering-config hashes;
- cache body/identity/key validation before reuse;
- DynamoDB atomic concurrency/spend reservation ledger;
- USD 50 initial effective cap and USD 150 absolute ceiling;
- direct runtime emission of `NvidiaActiveGpuJobs` / `NvidiaMonthlySpendUsd`;
- CDK completion queue, DynamoDB ledger, correct IAM, network isolation, and no endpoint resources;
- source-grounded/scorable gold preflight for all required strata;
- provider payload materializer requires PNG rendering provenance and refuses oversized records before Batch submission.

## P0 milestone evidence — NOT current-tip acceptance

During implementation, before the later strict-gold/provider-identity/payload-size tightenings, an isolated harness passed:

- modular Node syntax checks;
- P0 real-Batch/AWS tests: **15/15**.

Those tests were useful development evidence. **They do not validate the final branch head** because additional P0 code and tests were added afterward. Do not quote 15/15 as a final current-tip result. The final current-tip Session 5 suite is **34/34**.

The final branch now also contains additional tests for:

- strict scorable live-gold acceptance;
- requested route intent vs actual Nemotron provider identity;
- provider sidecar identity consistency;
- oversized provider payload refusal.

These require a fresh clean-checkout run before deployment eligibility can be reassessed.

## Pre-P0 historical gates — also not current-tip acceptance

Before the P0 runtime rewrite, the agent genuinely reran and passed:

- Session 2 DB rehearsal: 36 checks;
- Session 3 parity: 52/52;
- Session 3 DB rehearsal: 86 checks;
- defense-api DB suite: 64/64;
- Session 4 source parity and enforced replay;
- no-cache orchestrator image and containment;
- focused Session 5 tests and CDK tests.

The branch has since changed materially. These results establish the prerequisite baseline only; they must be rerun before deployment.

## Current GitHub Actions state

Repository Actions still fails at the repository startup layer before Session 5 jobs execute. This assignment used the functioning local Linux Docker engine (`desktop-linux`) instead. A startup failure is not a pass and is not evidence against the code either.

## Required fresh re-review gate before redeploy

Run from a clean checkout of the exact current Session 5 SHA:

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

Then independently inspect the CDK and live provider path. Passing tests alone do not authorize redeploy.

## Current AWS / Marketplace facts already established

- Account: `967807252336`
- Region: `us-east-1`
- Exact package ARN: `arn:aws:sagemaker:us-east-1:865070037744:model-package/nvidia-nemotron-parse-6673990e627d314f8aceb69f5e816587`
- Listing/model version: `LLM NIM 1.14 and VLM NIM version 1.5.0`
- Marketplace package requires `EnableNetworkIsolation: true`
- supported Batch instance verified by the agent: `ml.g5.xlarge`
- authorized initial target: **USD 50**
- hard incremental ceiling: **USD 150**
- max concurrent GPU jobs: **1**
- routing: benchmark
- benchmark accepted: false

The earlier failed CloudFormation attempt occurred before GPU/model/job creation because network isolation was absent. The empty bucket/stack were removed; the unused KMS key was scheduled for deletion. No paid NVIDIA work occurred.

## Provider truth / planned comparison lanes

The subscribed live Marketplace package currently implements **Nemotron Parse**. The legacy benchmark vocabulary also contains desired `nvidia_page_elements_table_structure` and `nvidia_ocr` lanes. Those remain route/comparison intents, not claims that separate provider packages are configured.

The v2 runtime therefore records:

- `requestedParserMethod`: governed desired lane;
- `parserMethod`: actual provider invoked (`nemotron_parse` for the current package).

Do not report a Nemotron Parse execution as a separate table-structure or OCR provider observation.

## Gold-corpus blocker

Even if the runtime passes re-review, `SESSION5_COMPLETE` cannot be asserted until accepted, source-grounded, **scorable** gold covers all eight strata. The strict live CLI gate requires:

- accepted review status;
- source evidence SHA;
- immutable source SHA and physical page;
- explicit identity/money/table assertion arrays;
- at least one scorable assertion;
- exact money values with unit/FY/evidence page when money is part of the gold;
- no incomplete/conflicted flag.

Current manifest records the known gaps explicitly.

The live verifier must remain closed until a genuine evidence file exists:

```bash
PHASE8_SESSION5_LIVE_BENCHMARK_EVIDENCE=\
  docs/defense-budget/phase8-session5-live-benchmark-evidence.json \
node scripts/verify-phase8-session5.mjs --enforce-live-benchmark
```

No evidence file has been fabricated.

The runtime verdict is `SESSION5_P0_RUNTIME_ACCEPTED_LIVE_CORPUS_BLOCKED`. Next action: prepare/approve source-grounded gold, then separately request authorization for an isolated observational/live run. Do not deploy or submit paid NVIDIA work from this assignment.

## Scope / mutation evidence

Since the P0 real-runtime blocker was identified:

- redeployed stack: **no**
- paid TransformJob: **no**
- persistent endpoint: **no**
- production routing/default change: **no**
- production/shared DB/data change: **no**
- production schedules: **no**
- production IAM/secrets: **no**
- snapshot activation: **no**
- canonical promotion: **no**
- Session 6: **not started**
