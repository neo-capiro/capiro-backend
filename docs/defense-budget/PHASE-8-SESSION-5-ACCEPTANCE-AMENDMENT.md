# Phase 8 — Session 5 acceptance amendment (provider acceptance only)

**Amendment ID:** `PHASE8-S5-ACCEPTANCE-AMENDMENT-1`
**Date:** 2026-08-20
**Amends:** `PHASE-8-DEFENSE-API-NVIDIA-MIGRATION-V3.md` — Workstream G gate, Session 5 sequencing entry, and final Phase 8 acceptance criterion 7
**Scope:** Session 5 provider acceptance **only**

## Why this amendment exists

The original Session 5 acceptance contract assumed a *successful* live provider
benchmark. Under that language, `SESSION5_COMPLETE` required genuine Nemotron
output, source-grounded NVIDIA scoring, a live evidence file, and a passing
enforced live-benchmark verifier.

None of those can be produced honestly. The approved provider/package/runtime
was proven operationally unusable through the governed deployment path:

- the exact pinned AWS Marketplace package resolves through `ModelDataSource`,
  and SageMaker rejected Batch Transform for that model form;
- the same Marketplace product explicitly excludes SageMaker Asynchronous
  Inference;
- two post-IAM-repair governed Async endpoint attempts were accepted by
  `CreateEndpoint` and resolved the Marketplace image/model, but both remained
  `Creating` (approximately `Launching 1 instance(s)`, `CurrentInstanceCount = 0`)
  and never reached `InService`;
- no `InvokeEndpointAsync` ever succeeded, and no Nemotron output exists.

`NVIDIA_NOT_ADOPTED / OPERATIONALLY_BLOCKED` is an architecturally valid Phase 8
outcome, but the pre-amendment language did not recognise it as an accepted
closeout. Without this amendment, Session 5 could only close by fabricating a
provider result — which is precisely what Capiro's truth boundary forbids.

## Amended Session 5 closeout rule

Session 5 may close through **exactly one** of the following paths.

### A. `LIVE_PROVIDER_ACCEPTED`

Genuine provider output exists, source-grounded scoring passes, the enforced
live verifier passes, zero-idle is proven, and page-class routing decisions are
supported by benchmark evidence.

Gate (unchanged):

```bash
PHASE8_SESSION5_LIVE_BENCHMARK_EVIDENCE=docs/defense-budget/phase8-session5-live-benchmark-evidence.json \
node scripts/verify-phase8-session5.mjs --enforce-live-benchmark
```

### B. `PROVIDER_NOT_ADOPTED`

The approved provider/package/runtime cannot reach governed inference after
bounded live attempts; the failure is documented; no unsupported provider result
is fabricated; deterministic parsing remains production primary; NVIDIA routing
remains disabled; zero-idle is proven; provider-neutral, provenance, Phase 2,
spend, and teardown controls remain intact; and the full Session 2–5 regression
suite passes.

Gate (new):

```bash
node scripts/verify-phase8-session5.mjs --enforce-provider-decision
```

Path B requires the durable negative-decision artifact
`docs/defense-budget/phase8-session5-provider-decision.json`
(schema `phase8_session5_provider_decision_v1`, schema file
`docs/defense-budget/phase8-session5-provider-decision.schema.json`).

That artifact **must not** impersonate
`docs/defense-budget/phase8-session5-live-benchmark-evidence.json`. The two paths
are mutually exclusive: the verifier refuses both enforcement flags at once, and
Path B fails if a live-benchmark evidence file exists at all.

## What Path B requires

The negative closeout is accepted only when every one of these holds:

```text
decision                       = NVIDIA_NOT_ADOPTED
status / operationallyBlocked  = OPERATIONALLY_BLOCKED / true
modelPackageArn                = the exact evaluated Marketplace package
executionPathsEvaluated        includes batch transform AND async inference
batchResult                    = MODELDATASOURCE_UNSUPPORTED
asyncResult                    = ENDPOINT_NEVER_INSERVICE
asyncAttempts                  >= 1 (bounded)
endpointReachedInService        = false
successfulInvokeEndpointAsync  = 0
providerOutputsProduced        = 0
accuracyBenchmarkCompleted     = false
nvidiaRoutingEnabled           = false
productionParser               = DETERMINISTIC_PRIMARY
productionRoutingChanged       = false
providerNeutralContractPresent = true
phase2StillMandatory           = true
zeroIdleProven                 = true
zeroIdleProof.activeEndpoints / activeEndpointConfigs / activeTransformJobs /
  activeScalableTargets / activeGpuCapacity / ledgerActiveJobs /
  activeReservations                                                    = 0
activeReservedSpendUsd         = 0
settledBenchmarkSpendUsd       <= authorized hard cap (USD 150)
contentSha256                  matches the artifact content
full Session 2-5 regression gates green
```

The verifier fails Path B if:

- the negative-closeout evidence claims **any** NVIDIA accuracy score (the
  contract rejects `accuracyScore`, `acceptedPageClasses`, `benchmarkResult`,
  `invocations`, `liveBenchmarkAccepted`, `nvidiaObservationCount`,
  `pageClassDecisions`, `providerOutputs`, `score`, `scores`);
- production NVIDIA routing is enabled;
- an endpoint, endpoint config, transform job, scalable target, or reservation
  remains active;
- a live evidence file is fabricated or merely present;
- the decision artifact is missing or its content hash does not match;
- the package identity differs from the evaluated package;
- provider output actually exists but has not been evaluated
  (`providerOutputsProduced` must be exactly `0`).

## What this amendment explicitly does NOT do

This is a narrow provider-acceptance amendment. It does **not**:

- declare the NVIDIA accuracy benchmark successful;
- imply Nemotron was scored, or that any Nemotron output exists;
- claim NVIDIA is production-ready;
- weaken wrong-money, wrong-unit, wrong-fiscal-year, or false-identity
  protections;
- remove or soften Phase 2, which remains mandatory for every parser provider;
- change production routing or any production default;
- permit a persistent GPU endpoint;
- authorize a different NVIDIA runtime or artifact;
- remove the zero-idle requirement;
- rewrite the Phase 8 architecture or any later Phase 8 session.

## Effect on Phase 8 final acceptance

Final Phase 8 acceptance criterion 7 previously read:

> NVIDIA parsing is integrated behind the provider-neutral parser router and
> selected only where benchmark evidence supports it.

It is satisfied in the negative direction: NVIDIA parsing **is** integrated
behind the provider-neutral router, and it is selected **nowhere**, because no
benchmark evidence supports selecting it. Criteria 8, 9, and 11 are likewise
satisfied — there is no persistent GPU endpoint, active GPU capacity is zero,
and deterministic parsing remains production primary.

Criterion 10 (Nemotron Parse via Batch Transform by default) is **not**
satisfied and is superseded for the current package: the pinned Marketplace
artifact cannot use Batch Transform at all. Re-opening NVIDIA adoption therefore
requires a **separately approved** runtime/artifact decision. Nothing in this
amendment authorizes NGC/NIM, BYOC/ECR, AWS Batch EC2 GPU, an alternative
Marketplace package, a different instance type, or another NVIDIA artifact.

## Preserved Session 5 deliverables

The negative provider decision does not invalidate the architecture-neutral work
Session 5 proved. The following remain accepted and must not be removed or
weakened:

- provider-neutral parser contract, with NVIDIA behind it and dark;
- immutable source/page/model/options provenance;
- Phase 2 mandatory for every provider;
- deterministic parsing supported and production primary;
- page-class routing framework and provider decision framework;
- atomic spend reservation and settlement controls;
- idempotent endpoint/config teardown;
- failed-endpoint reservation handling;
- timestamp-derived failed lifecycle cost settlement;
- explicit `ENDPOINT_LIFETIME_EXCEEDED`;
- compact DLQ envelope;
- scale-to-zero only after `InService`;
- legal/idempotent DynamoDB settlement;
- zero-idle enforcement and drain/zero-idle operator commands.

Any future NVIDIA runtime can reuse these abstractions under a separately
approved phase or change.

## Resulting Session 5 verdict

```text
SESSION5_COMPLETE_NVIDIA_NOT_ADOPTED
```

Session 5 completed as a **negative adoption decision**, not as a successful
NVIDIA benchmark. Plain `SESSION5_COMPLETE` is deliberately **not** redefined.
