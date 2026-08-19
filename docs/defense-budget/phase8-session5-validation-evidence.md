# Phase 8 Session 5 validation evidence

This file records the permanent command set for the exact branch tip associated with the Session 5 draft pull request.

## Provider-ready implementation gates

- Node syntax checks: PASS
- Session 5 orchestrator unit tests: PASS — 17/17
- Provider-neutral architecture verifier: `SESSION5_PROVIDER_READY_PASS`
- `@capiro/defense-contracts` build: PASS
- `@capiro/infra-cdk` typecheck: PASS
- focused CDK synth assertions: PASS — 5/5
- no-cache orchestrator image build: PASS
- container UID: 1001
- exposed ports: none
- CUDA/NVIDIA driver/model runtime in image: none
- static AWS/Clerk/database credentials in image: none
- `git diff --check`: PASS

## Accepted Session 2–4 regressions rerun

- Session 2 static boundary: PASS
- Session 2 disposable PostgreSQL rehearsal: PASS — 36 checks
- Session 3 route/business boundary: PASS — 49/49 routes
- Session 3 governed-admin boundary: PASS
- Session 3 old-vs-new parity: PASS — 52/52
- Session 3 disposable PostgreSQL rehearsal: PASS — 86 checks
- Session 4 source parity: PASS
- Session 4 enforced FY27 replay: PASS

## Required negative control

`node scripts/verify-phase8-session5.mjs --enforce-live-benchmark` must fail until an approved model package, real FY27 NVIDIA provider artifacts, accepted scoring, and zero-idle proof are retained in the evidence file.

That negative control passed: the live gate remained closed rather than accepting the provider-validation fixture as proof of NVIDIA quality.

## Live authorization reconciliation — 2026-08-18

Read-only AWS checks were run as `arn:aws:iam::967807252336:user/capirocli` in `us-east-1` through the `capiro-dev` profile.

- The account has one active Marketplace purchase agreement, and it is a `SaaSProduct` (`prod-ffvjxvh4ltq64`), not an NVIDIA machine-learning product.
- `aws sagemaker list-model-packages --max-results 20` returned no model packages; no NVIDIA/Nemotron model-package group was found.
- No resource is tagged `CapiroPhase=phase8-session5`; no `capiro` transform job and no `capiro-defense-nvidia` endpoint exists.
- The existing account-wide monthly budget is USD 500, but it is not a Session 5-approved hard GPU cap. Its observed month-to-date spend is USD 1,421.283 and forecast is USD 2,728.831, so it cannot be repurposed or treated as authority for a paid benchmark.
- Docker Desktop's Linux engine is unavailable on this host, so Docker/no-cache image and disposable-DB gates cannot be rerun locally until the daemon is available.

This established a hard pre-spend stop at the time. On 2026-08-18 Neo subsequently authorized a USD 150 hard incremental AWS/NVIDIA ceiling, with an initial benchmark target of no more than USD 50; the runtime must retain `NVIDIA_MAX_CONCURRENT_GPU_JOBS=1`, `NVIDIA_ROUTING_MODE=benchmark`, and `NVIDIA_BENCHMARK_ACCEPTED=false`. The approved spend ceiling removes only the budget blocker. No CDK deployment or SageMaker job submission has been attempted because a usable account/region-specific, version-pinned NVIDIA Marketplace model package is still absent.

## Current verdict

`SESSION5_PROVIDER_READY_LIVE_BENCHMARK_BLOCKED`

Exact blocker: `NVIDIA Marketplace Nemotron Parse subscription/model-package approval and an explicit Session 5 hard GPU budget are absent for AWS account 967807252336 in us-east-1.`

No AWS deployment, production database migration, production data mutation, routing change, schedule change, IAM/secrets change, snapshot activation, canonical promotion, persistent endpoint, or production NVIDIA default change occurred.
