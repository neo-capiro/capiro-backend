# Phase 8 Session 5 — NVIDIA benchmark and ephemeral GPU handoff

## Verdict

**SESSION5_PROVIDER_READY_LIVE_BENCHMARK_BLOCKED**

The provider-neutral orchestration, Batch Transform infrastructure definition, safety gates, benchmark scorer, regression tests, image boundary, and live-evidence contract are implemented on the Session 5 branch. A real NVIDIA model run is not represented as complete because the repository contains no approved/pinned Marketplace model-package ARN and no retained NVIDIA outputs for the real FY27 gold corpus.

No benchmark result was fabricated.

## Repository coordinates

- Repository: `neo-capiro/capirov2`
- Base: `agent/phase8-session4-after-s3`
- Base head when Session 5 started: `a5094361f9da82e70090f73da46b11108e6a8b45`
- Branch: `agent/phase8-session5-nvidia-benchmark`
- PR: created as a draft; see branch/PR metadata for the final head
- Session 3 prerequisite: draft PR #1058, accepted locally
- Session 4 prerequisite: draft PR #1062, accepted locally

## Architecture delivered

### Separate non-HTTP orchestration plane

`apps/defense-parser-orchestrator` owns NVIDIA job planning and execution. It has:

- no HTTP listener or exposed port;
- no Clerk, tenant, CRM, Prisma, PostgreSQL, snapshot, or promoter dependency;
- no CUDA, GPU driver, model weight, or persistent inference server;
- command-only operation through Node 20 and AWS CLI v2;
- task-role authentication only.

The existing deterministic Python runtime remains AWS-free and unchanged.

### Provider-neutral contracts

`packages/defense-contracts/src/parser/nvidia-batch.ts` defines:

- pinned NVIDIA provider identity;
- Batch Transform request/result contracts;
- page artifact/evidence contract;
- job-run provenance;
- cost guards;
- benchmark corpus/result contracts;
- the four page-class routing decisions.

### NvidiaBatchCoordinator

The coordinator:

1. accepts only pages selected by governed escalation;
2. calculates a page cache key from source SHA, page, method, model name/version, options hash, and runtime-contract version;
3. skips immutable cached results;
4. groups compatible pages under a configured maximum batch size;
5. writes deterministic JSONL manifests;
6. refuses submissions above concurrency, page-count, or hard monthly spend limits;
7. submits SageMaker Batch Transform jobs;
8. records append-only job-state events and a materialized latest state in an isolated S3 prefix;
9. consumes completion/failure events;
10. verifies source identity, model/method/options identity, and artifact SHA before caching output;
11. publishes a completion event only after verification;
12. sends failures to a DLQ without fabricating fallback content;
13. exposes a zero-idle proof requiring zero active jobs and zero persistent endpoints.

### AWS/CDK benchmark plane

`Phase8Session5NvidiaBenchmark` defines, but does not deploy:

- KMS-encrypted, versioned, public-blocked benchmark S3 storage;
- FIFO escalation queue and FIFO DLQ;
- SageMaker model referencing a pinned Marketplace model package;
- a Batch Transform service role;
- a separate non-HTTP orchestrator task role;
- narrowly scoped Batch Transform permissions;
- no `CreateEndpoint`, `UpdateEndpoint`, or endpoint resource;
- queue, DLQ, concurrency, and application-spend alarms.

The construct creates zero `AWS::SageMaker::Endpoint` and zero `AWS::SageMaker::EndpointConfig` resources.

### Benchmark scorer

The scorer measures per provider and page class:

- PE, project, and line identity precision/recall;
- exact money including FY, unit, and evidence page;
- table cell reconstruction;
- Phase 2 blocking omissions;
- false identities;
- evidence-binding regressions;
- duration;
- GPU seconds;
- cost;
- error rate.

It selects a route separately for each page class and cannot select NVIDIA when wrong-money, false-identity, evidence-binding, or blocking-omission regressions exist. Model version and parser options must be pinned.

## Required live benchmark strata

The frozen manifest includes:

1. R-1 pages with zero native tables;
2. R-2 identity/banner pages;
3. R-2A project/cost tables;
4. scanned/image-only pages;
5. Navy BA6 duplicate/flattening cases;
6. P-1 tables;
7. O-1/OP-5 tables;
8. Defense-Wide volumes.

The live run must compare deterministic parsing, cached LlamaParse when available, Nemotron Parse, NVIDIA table structure, and NVIDIA OCR where applicable.

## Commands

Provider-ready gates:

```bash
corepack enable
corepack prepare pnpm@9.12.0 --activate
pnpm install --frozen-lockfile

pnpm --filter @capiro/defense-contracts build
node --check apps/defense-parser-orchestrator/src/session5.mjs
node --check apps/defense-parser-orchestrator/src/aws-runtime.mjs
node --check apps/defense-parser-orchestrator/src/cli.mjs
node --test apps/defense-parser-orchestrator/test/*.test.mjs
node scripts/verify-phase8-session5.mjs

pnpm --filter @capiro/infra-cdk typecheck
pnpm --filter @capiro/infra-cdk exec jest \
  test/phase8-session5-nvidia-benchmark.test.ts --runInBand

docker build --no-cache \
  -f apps/defense-parser-orchestrator/Dockerfile \
  -t capiro-defense-parser-orchestrator:phase8-session5 .

test "$(docker run --rm --entrypoint id \
  capiro-defense-parser-orchestrator:phase8-session5 -u)" = "1001"

docker run --rm capiro-defense-parser-orchestrator:phase8-session5 help
git diff --check
```

Live benchmark gate after isolated AWS execution:

```bash
PHASE8_SESSION5_LIVE_BENCHMARK_EVIDENCE=\
  docs/defense-budget/phase8-session5-live-benchmark-evidence.json \
node scripts/verify-phase8-session5.mjs --enforce-live-benchmark
```

## Live-run procedure

1. Approve and record the exact AWS Marketplace model-package ARN/version.
2. Materialize the real FY27 gold entries with source SHA and physical page number for every required stratum.
3. Deploy only isolated benchmark resources using the Session 5 construct.
4. Set `NVIDIA_ROUTING_MODE=benchmark`; never `preferred` for the initial run.
5. Set a positive hard monthly application budget and maximum one concurrent job.
6. Run deterministic/current providers and NVIDIA routes over the same bytes/pages.
7. Preserve raw provider artifacts and normalized observations under immutable S3 keys.
8. Generate benchmark evidence with page-class decisions.
9. Drain the queue and jobs.
10. Run `zero-idle` and retain proof that active jobs = 0 and endpoints = 0.
11. Execute `--enforce-live-benchmark`.
12. Destroy or retain only non-compute evidence resources according to the benchmark runbook; no GPU capacity remains.

## Hard scope statement

- Merge: **none**
- AWS deployment/mutation: **none**
- Production/shared DB migration: **none**
- Production data mutation: **none**
- ALB/ECS routing: **none**
- EventBridge schedules: **none**
- IAM/secrets in AWS: **none**
- Snapshot activation: **none**
- Canonical promotion: **none**
- Persistent NVIDIA endpoint: **none**
- Production NVIDIA default: **unchanged**
- Session 6: **not started**

## Live authorization check — 2026-08-18

Read-only checks against the intended benchmark account established:

- Account/region: `967807252336` / `us-east-1`
- Caller: `arn:aws:iam::967807252336:user/capirocli` through `capiro-dev`
- Marketplace: the only active accepted purchase agreement is a `SaaSProduct` (`prod-ffvjxvh4ltq64`), not an NVIDIA machine-learning product.
- SageMaker: no registered model package and no NVIDIA/Nemotron model-package group exists in the account/region.
- Existing Session 5 plane: no resource with tag `CapiroPhase=phase8-session5`, no `capiro` transform job, and no `capiro-defense-nvidia` endpoint exists.
- Cost authority: the USD 500 account-wide monthly budget is not an explicit Session 5 GPU authorization; with month-to-date spend USD 1,421.283 and forecast USD 2,728.831, it must not be used as a benchmark hard cap.

No CDK deployment, SageMaker model creation, transform submission, provider invocation, or paid GPU operation was attempted. The local Docker Desktop Linux engine is unavailable, preventing no-cache image and disposable-DB reruns on this host.

## Remaining blocker

A true `SESSION5_COMPLETE` verdict requires real provider evidence. Specifically:

- Neo must accept the exact NVIDIA Marketplace Nemotron Parse product for AWS account `967807252336` in `us-east-1` and provide the resulting approved, version-pinned SageMaker model-package ARN, model name, and version. Do not accept an unversioned alias or substitute product.
- Neo must explicitly approve a positive hard Session 5 GPU budget (USD cap) before any paid job. The account-wide budget is not authorization.
- After these two prerequisites, actual NVIDIA outputs must be retained for all eight FY27 strata, then source-grounded scoring must show zero safety regressions, accepted cost/throughput, and a retained zero-idle proof.

Until those are supplied and the live gate passes, the correct verdict remains:

`SESSION5_PROVIDER_READY_LIVE_BENCHMARK_BLOCKED`
