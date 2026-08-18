# Capiro defense parser orchestrator

Phase 8 Session 5 command-driven orchestration plane for governed NVIDIA parser escalation.

This is **not** the public `defense-api` service and it is **not** the deterministic Python parser. It exists so only a non-HTTP task role can create ephemeral NVIDIA Batch Transform jobs.

## Security and ownership boundary

The orchestrator:

- accepts only pages already approved by the governed escalation policy;
- never connects to PostgreSQL;
- never writes canonical defense-budget truth;
- never activates a snapshot or executes promotion;
- never receives Clerk, tenant, CRM, or public-service credentials;
- never starts a real-time SageMaker endpoint;
- never contains CUDA, NVIDIA drivers, or model weights;
- uses the task role through AWS CLI v2 rather than static credentials;
- resumes semantic extraction and Phase 2 only after provider artifact identity and SHA verification.

The deterministic parser in `apps/defense-budget-parser` remains AWS-free and owns only local CPU parsing.

## Zero-idle execution model

The supported NVIDIA path is SageMaker **Batch Transform**:

1. deterministic parsing identifies unresolved pages;
2. governed page routing approves only the required page classes;
3. the coordinator deduplicates by source SHA + page + method + pinned model version + options hash;
4. compatible pages are written as an immutable S3 JSONL manifest;
5. one Batch Transform job is submitted;
6. output is verified and cached per page;
7. a completion event resumes the trusted extraction/Phase 2 pipeline;
8. the transform job terminates, leaving zero GPU capacity.

The runtime deliberately exposes no create-endpoint operation.

## Commands

```bash
node src/cli.mjs validate-config
node src/cli.mjs benchmark --corpus corpus.json --out result.json
node src/cli.mjs plan --request request.json --out plan.json
node src/cli.mjs submit --plan plan.json --out submitted.json
node src/cli.mjs handle-event --event event.json --out result.json
node src/cli.mjs zero-idle --out proof.json
```

## Required configuration for a live benchmark job

```text
NVIDIA_PARSING_ENABLED=true
NVIDIA_ROUTING_MODE=benchmark
NVIDIA_BENCHMARK_ACCEPTED=false
NVIDIA_MAX_CONCURRENT_GPU_JOBS=1
NVIDIA_MAX_PAGES_PER_JOB=<measured>
NVIDIA_MONTHLY_GPU_BUDGET_USD=<hard application limit>
NVIDIA_PROJECTED_GPU_SECONDS_PER_PAGE=<measured>
NVIDIA_PROJECTED_USD_PER_GPU_SECOND=<measured>
NVIDIA_MODEL_NAME=nemotron-parse
NVIDIA_MODEL_VERSION=<pinned Marketplace model-package version>
NVIDIA_SAGEMAKER_MODEL_NAME=<pre-created benchmark model>
NVIDIA_BATCH_TRANSFORM_ROLE_ARN=<benchmark role ARN>
NVIDIA_INPUT_BUCKET=<isolated benchmark bucket>
NVIDIA_OUTPUT_BUCKET=<isolated benchmark bucket>
NVIDIA_COMPLETION_QUEUE_URL=<FIFO queue>
NVIDIA_DLQ_URL=<FIFO DLQ>
NVIDIA_INSTANCE_TYPE=ml.g5.xlarge
```

`preferred` routing is rejected unless accepted benchmark evidence is explicitly configured. Session 5 does not make a production default change.

## Benchmark decisions

The scorer makes a separate decision for every page class:

- `DETERMINISTIC_PRIMARY`
- `NVIDIA_PRIMARY`
- `NVIDIA_FALLBACK`
- `MANUAL_REVIEW`

An NVIDIA route cannot be selected if it introduces any wrong-money, false-identity, Phase 2 blocking omission, or evidence-binding regression in the gold corpus. Model name, version, and parser options must be pinned.

## Local tests

```bash
node --test apps/defense-parser-orchestrator/test/*.test.mjs
node scripts/verify-phase8-session5.mjs
```

The included validation corpus proves the scoring engine, not NVIDIA model quality. Live acceptance remains closed until real FY27 NVIDIA artifacts are supplied and `--enforce-live-benchmark` passes.
