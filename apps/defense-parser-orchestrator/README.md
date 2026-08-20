# Capiro defense parser orchestrator

Phase 8 Session 5 command-driven orchestration plane for governed NVIDIA parser escalation.

This is **not** the public `defense-api` service and it is **not** the deterministic Python parser. It exists so only a non-HTTP task role can create ephemeral NVIDIA Batch Transform jobs.

## Current Session 5 status

`SESSION5_P0_RUNTIME_IMPLEMENTED_RE_REVIEW_REQUIRED`

The Marketplace package is subscribed and pinned, but paid work remains blocked. A real-runtime review found mismatches in the original simulation-oriented Batch path; the branch now contains a separate `nvidia_real_batch_v2` path with provider-native payload/output handling, reconciliation, an atomic spend/concurrency ledger, durable completion/DLQ recovery, and stricter cache identity. It must be fully re-reviewed and the FY27 gold corpus must be accepted before any redeploy or TransformJob submission.

## Security and ownership boundary

The orchestrator:

- accepts only pages already approved by governed escalation;
- never connects to PostgreSQL;
- never writes canonical defense-budget truth;
- never activates a snapshot or executes promotion;
- never receives Clerk, tenant, CRM, or public-service credentials;
- never starts a real-time SageMaker endpoint;
- never contains GPU drivers or model weights;
- uses an AWS task role rather than static credentials;
- resumes semantic extraction and Phase 2 only after normalized artifact identity and SHA verification.

The deterministic parser in `apps/defense-budget-parser` remains AWS-free.

## Real Batch v2 contract

The live path sends one provider-native OpenAI-compatible Nemotron Parse JSON request per line while advertising the model-supported MIME type:

- `ContentType: application/json`
- `SplitType: Line`
- `Accept: application/json`
- `AssembleWith: Line`

Internal source/model/rendering/cache provenance is **not** invented inside provider output. It is stored in an immutable hashed input sidecar and joined back to the real line-oriented `.out` bytes during reconciliation. The normalized artifact retains both the raw-provider-output SHA and the sidecar-bound identity.

The cache key binds:

- source SHA and physical page;
- parser method;
- model name/version;
- parser-options hash;
- rendered PNG hash;
- provider-payload hash;
- rendering-config hash;
- runtime-contract version.

## Runtime recovery

Provider status, timestamps and spend facts are always re-read from SageMaker. Caller-supplied `actualCostUsd`, provider status, or output handles are not accepted as truth.

Commands:

```bash
node src/cli.mjs validate-config
node src/cli.mjs benchmark --corpus corpus.json --out result.json --enforce-live true
node src/cli.mjs plan --request materialized-request.json --out plan.json
node src/cli.mjs submit --plan plan.json --out submitted.json
node src/cli.mjs reconcile --job-id <id> --out state.json
node src/cli.mjs reconcile --all true --out states.json
node src/cli.mjs retry --job-id <id> --out state.json
node src/cli.mjs watch --job-id <id> --interval-seconds 30 --max-seconds 3600 --out state.json
node src/cli.mjs zero-idle --out proof.json
```

Reconciliation recovers pre-submission crashes, polls/reads terminal provider facts, requests a stop after the watchdog limit, waits for provider terminal state before settling spend, normalizes and verifies output, and retries completion/DLQ publication durably.

## Spend authorization

Current authorization is fixed at:

```text
NVIDIA_ROUTING_MODE=benchmark
NVIDIA_BENCHMARK_ACCEPTED=false
NVIDIA_MAX_CONCURRENT_GPU_JOBS=1
NVIDIA_INITIAL_BENCHMARK_CAP_USD=50
NVIDIA_HARD_INCREMENTAL_CAP_USD=150
NVIDIA_EXTENDED_BUDGET_AUTHORIZED=false
NVIDIA_INSTANCE_TYPE=ml.g5.xlarge
```

The live runtime requires an atomically updated DynamoDB reservation ledger. By default, reservations may consume at most the **USD 50 initial cap**. The USD 150 hard ceiling is not usable unless `NVIDIA_EXTENDED_BUDGET_AUTHORIZED=true` is explicitly set after another authorization decision. A conservative reservation-rate floor prevents a stale low hourly-price input from under-reserving work.

## Provider payload materialization

Before `plan`, render the selected physical PDF pages to PNG with an explicit renderer/version/DPI configuration and run:

```bash
node scripts/materialize-live-inputs.mjs --request request.json --out materialized-request.json
```

The materializer creates the provider-native `nvidia/nemotron-parse` request with `markdown_bbox`, `temperature: 0.0`, and a PNG `image_url`; it records the rendered-image, rendering-config, and exact provider-payload SHA-256 values used by cache identity.

## FY27 acceptance remains closed

The code deliberately refuses a live acceptance corpus unless **every required stratum** has human/previously accepted source-grounded gold with a source-evidence SHA and no incomplete/conflicted flag. Current known gaps include scanned-image gold, conflicted/incomplete R-2 and Navy BA6 material, and missing accepted normalized P-1/O-1/OP-5 artifacts.

Do not submit paid work merely to create observational evidence and then label model output as gold.

## Local validation

```bash
node --test apps/defense-parser-orchestrator/test/*.test.mjs
node scripts/verify-phase8-session5.mjs
pnpm --filter @capiro/infra-cdk typecheck
pnpm --filter @capiro/infra-cdk exec jest test/phase8-session5-nvidia-benchmark.spec.ts --runInBand
```

`SESSION5_COMPLETE` remains impossible until the real source-grounded corpus is accepted, paid provider outputs are retained, scoring passes, zero-idle is proven directly against both the ledger and SageMaker, and `--enforce-live-benchmark` passes.
