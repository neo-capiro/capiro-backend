# Phase 8 Session 5 — closeout handoff (NVIDIA not adopted)

> Supersedes the previous
> `SESSION5_ASYNC_RUNTIME_READY_AWAITING_LIVE_RUN_AUTHORIZATION` handoff. The
> prior text remains in git history.

## Session 5 result

```text
SESSION5_COMPLETE_NVIDIA_NOT_ADOPTED

providerDecision           = NVIDIA_NOT_ADOPTED
providerOperationalStatus  = OPERATIONALLY_BLOCKED
productionParser           = DETERMINISTIC_PRIMARY
nvidiaRoutingEnabled       = false
activeGpuCapacity          = 0
activeReservations         = 0
liveNemotronOutputs        = 0
accuracyBenchmarkCompleted = false
session6Started            = false
```

Session 5 closed as a **negative adoption decision**, not as a successful NVIDIA
benchmark. Plain `SESSION5_COMPLETE` is deliberately not redefined.

## Exact coordinates

- Repository: `neo-capiro/capirov2`
- Branch: `agent/phase8-session5-nvidia-benchmark`
- Draft PR: #1069 (open, draft, unmerged)
- Base: `agent/phase8-session4-after-s3`
- AWS account/region: `967807252336` / `us-east-1`
- Live-attempt / diagnostic baseline head: `b41898bbb5e15c1ab73e536d0e9e52f9b0788833`
- Frozen corpus SHA: `a4bf213ea908f6dff2988e1ec3c78d0d5359a8e085554cb1915721b687fc8e98`
- Parser options SHA: `890f08082befbee5261b4c77f0646d647a98d402bfd31c0dcb022f2610cf688a`
- Rendering config SHA: `800a38fb9e8a4f8e014febe9822a5ca075596cf03d8544ab2aa67d9856f8a2fc`
- Corpus: 8/8 strata accepted, 0 blocked, 10 prepared pages

## Why

The exact approved Marketplace package/runtime cannot reach governed inference
through either approved Session 5 execution path.

- **Provider evaluated:** `arn:aws:sagemaker:us-east-1:865070037744:model-package/nvidia-nemotron-parse-6673990e627d314f8aceb69f5e816587`
- **Model/version:** `nemotron-parse` / `LLM NIM 1.14 and VLM NIM version 1.5.0`
- **Marketplace product:** `prod-jpaccpvt6aut4`
- **Instance tested:** `ml.g5.xlarge`

### Batch Transform path

Blocked. The exact Marketplace model resolves through `ModelDataSource`, and
SageMaker rejected Batch Transform for that model form:

```text
SageMaker Batch currently doesn't support Model entity with container
definitions which use ModelDataSource attribute
```

TransformJobs created: `0`. Paid GPU spend on that path: `USD 0`.

### Async Inference path

Operationally blocked. Two governed post-IAM endpoint attempts:

- `CreateEndpoint` accepted;
- Marketplace image/model resolution succeeded;
- endpoint remained `Creating`;
- status approximately `Launching 1 instance(s)`;
- `CurrentInstanceCount = 0`;
- never reached `InService`;
- `InvokeEndpointAsync = 0`;
- no provider output.

The strongest supported explanation is Marketplace Async incompatibility: the
pinned Marketplace product **explicitly excludes** SageMaker Asynchronous
Inference. The exact internal SageMaker failure reason was **not retained**, so
no AWS failure reason is asserted anywhere in the evidence.

## Benchmark truth (do not overstate)

- no endpoint ever reached `InService`;
- `InvokeEndpointAsync = 0`;
- no Nemotron output exists;
- no live source-grounded NVIDIA accuracy scoring occurred;
- `docs/defense-budget/phase8-session5-live-benchmark-evidence.json` does
  **not** exist, and its absence is correct;
- the enforced live verifier never passed;
- no NVIDIA page class was accepted as primary or fallback based on live output.

No live evidence file was fabricated to satisfy the previous verifier.

## Production parser decision

`DETERMINISTIC_PRIMARY`.

## NVIDIA state

Dark / disabled. Not adopted. No production routing change.

## Spend

Historical Session 5 settled spend: **USD 1.00**.

`spentAndReservedUsd = 1` is historical settled spend, **not** an active GPU
reservation. Active reserved spend is `0`.

## AWS (read-only verification, no mutation this session)

```text
endpoints              = 0
endpointConfigs        = 0
TransformJobs          = 0
scalableTargets        = 0
activeGpuCapacity      = 0
ledger.activeJobs      = 0
activeReservations     = 0   (5 ledger reservations, all terminal: 4 RELEASED, 1 SETTLED)
ledger.settledSpendUsd = 1
CloudFormation         = UPDATE_COMPLETE
Drift                  = IN_SYNC
SageMaker models       = 1 (pinned control-plane model only; no endpoint)
notebook instances     = 0
```

Stack `CapiroPhase8Session5NvidiaBenchmark` was **not** destroyed.
Decommissioning belongs to its proper later workstream (Workstream R /
Session 12) and requires separate authorization.

## Acceptance amendment

Session 5 could not close under the original acceptance contract, which assumed
a successful live provider benchmark. A narrow amendment now permits a negative
provider decision:

- `docs/defense-budget/PHASE-8-SESSION-5-ACCEPTANCE-AMENDMENT.md`
  (`PHASE8-S5-ACCEPTANCE-AMENDMENT-1`)

It amends only Session 5 **provider acceptance** — Workstream G's gate, the
Session 5 sequencing entry, and final acceptance criteria 7/10 in
`PHASE-8-DEFENSE-API-NVIDIA-MIGRATION-V3.md`. It does not declare the benchmark
successful, does not imply Nemotron was scored, does not weaken
wrong-money/wrong-unit/wrong-FY/false-identity protections, does not remove
Phase 2, does not change production routing, does not permit a persistent GPU
endpoint, does not authorize a different NVIDIA runtime, and does not remove the
zero-idle requirement.

## Closeout gates

Session 5 now closes through exactly one of two mutually exclusive paths. The
verifier refuses both enforcement flags at once.

```bash
# Path A (unchanged, never passed):
PHASE8_SESSION5_LIVE_BENCHMARK_EVIDENCE=docs/defense-budget/phase8-session5-live-benchmark-evidence.json \
node scripts/verify-phase8-session5.mjs --enforce-live-benchmark

# Path B (the accepted path):
node scripts/verify-phase8-session5.mjs --enforce-provider-decision
# -> [phase8-session5] SESSION5_COMPLETE_NVIDIA_NOT_ADOPTED
```

Negative-decision evidence:
`docs/defense-budget/phase8-session5-provider-decision.json`
(schema `phase8_session5_provider_decision_v1`; schema file
`docs/defense-budget/phase8-session5-provider-decision.schema.json`;
regenerate with `scripts/phase8-session5-provider-decision.mjs`).

It does **not** impersonate the live-benchmark evidence file: distinct path,
distinct schema version, and Path B fails outright if a live-benchmark evidence
file exists at all.

## Preserved safety findings

These are accepted Session 5 deliverables and must not be removed or weakened.

**Provider-neutral architecture**
- NVIDIA remains behind the provider-neutral parser contract;
- no NVIDIA output can write canonical Program Element truth directly;
- Phase 2 remains mandatory;
- source/page/model/options provenance remains immutable;
- deterministic parsing remains supported and primary.

**Zero-idle controls**
- endpoint variant autoscaling `MinCapacity=0`, `MaxCapacity=1`;
- explicit delete mandatory after completion or failure;
- hard endpoint lifetime bound (`NVIDIA_MAX_ENDPOINT_LIFETIME_SECONDS`, 1800s);
- `async-drain` / `async-zero-idle` operator commands;
- zero-idle requires ledger active capacity zero and no Session 5 endpoints.

**Failure-path hardening**
- idempotent endpoint/config teardown;
- failed-endpoint reservation handling;
- timestamp-derived failed lifecycle cost settlement;
- explicit `ENDPOINT_LIFETIME_EXCEEDED`;
- compact DLQ envelope;
- scale-to-zero only after `InService`;
- legal/idempotent DynamoDB settlement.

**Architecture-neutral work kept for any future provider**
Provider contract, provider provenance structure, page-class routing framework,
spend controls, teardown controls, zero-idle enforcement, provider decision
framework, parser normalization, and failure-state handling all remain. The
NVIDIA provider is kept dark/disabled and can be re-approached under a
separately approved phase.

## No active production NVIDIA route

Now statically gated by `scripts/verify-phase8-session5.mjs`:

- deterministic parsing remains the default routing decision;
- NVIDIA can never be preferred unless benchmark acceptance is explicitly true
  (and the manifest pins `nvidiaBenchmarkAccepted: false`);
- `defense-api` serve task forbids `NVIDIA_*` and `DEFENSE_PARSER_MODEL_*` env;
- the public HTTP service has no GPU runtime responsibility;
- the benchmark control plane has no schedule that could auto-create GPU
  capacity;
- CDK publishes an explicit zero persistent-endpoint contract;
- the orchestrator image contains no GPU runtime;
- `defense-api` has no parser-orchestrator import.

## Re-verification commands

```bash
pnpm install --frozen-lockfile

pnpm --filter @capiro/shared build
pnpm --filter @capiro/auth build
pnpm --filter @capiro/defense-contracts build
pnpm --filter @capiro/defense-domain build
pnpm --filter @capiro/defense-client build

node --test apps/defense-parser-orchestrator/test/*.test.mjs

node scripts/verify-phase8-session5.mjs
node scripts/verify-phase8-session5.mjs --enforce-provider-decision
node scripts/verify-phase8-session5-corpus.mjs

pnpm --filter @capiro/infra-cdk typecheck
pnpm --filter @capiro/infra-cdk exec jest \
  test/phase8-session5-nvidia-benchmark.spec.ts --runInBand

pnpm verify:phase8-session2
pnpm verify:phase8-session2:db
pnpm verify:phase8-session3
pnpm verify:phase8-session3:admin
pnpm verify:phase8-session3:parity
pnpm verify:phase8-session3:db

pnpm --filter @capiro/defense-api verify:session4
PHASE8_SESSION4_REPLAY_EVIDENCE=docs/defense-budget/phase8-session4-fy27-replay-evidence.json \
  node scripts/verify-phase8-session4.mjs --enforce-replay
pnpm verify:phase8-session4:image

git diff --check
```

## Next session

**Session 6 — Federal Funding Event foundation + ingestion** (Workstreams H, I).

> **DO NOT START SESSION 6 UNTIL THE USER REVIEWS AND ACCEPTS THIS SESSION 5
> CLOSEOUT.**

## Merge-readiness handoff

Closing Session 5 does **not** authorize merging the stacked Phase 8 PRs. The
stack is:

- Session 3 — PR #1058
- Session 4 — PR #1062
- Session 5 — PR #1069 (draft, unmerged)

The next step is a **separate merge/readiness decision**. Do not blindly merge
all three, do not rebase accepted work unnecessarily, do not force-push, and do
not delete historical/security branches.

Note: GitHub Actions is billing-blocked on this repository, so CI has produced no
green run for this branch. All recorded results are local exact-head results.

## Scope statement for this closeout assignment

- AWS mutation: **none** (read-only verification only)
- Endpoint created: **none**
- `InvokeEndpointAsync`: **none**
- GPU capacity launched: **none**
- Quota request: **none**
- Model package / instance type change: **none**
- Alternative NVIDIA runtime (NGC/NIM, BYOC/ECR, AWS Batch EC2 GPU): **none**
- Provider/GPU spend: **USD 0 additional**
- Production routing / defaults / schedules / IAM / secrets: **unchanged**
- Production or shared DB migration / data mutation: **none**
- Snapshot activation / canonical promotion: **none**
- Stack destroyed: **no**
- PR merged: **none**
- Session 6: **not started**
