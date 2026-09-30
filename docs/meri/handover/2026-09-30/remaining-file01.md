# Remaining original File01 work

Verdict: **BLOCKED for full acceptance / release**, not a finding that every untested feature is broken. Source audit pinned to main `25d1339c0c0e21fe0c3c0148787fad772e5096e8`, with the separate PR #1915 repair series described in [README](README.md). No new live run is claimed here.

## Scope map

| Original scope | Already consolidated | Work/evidence still needed |
| --- | --- | --- |
| Workstream A / P0B–P0C | Truthful outcomes, in-Meri review/reload/error contracts, readable-file and attachment changes, canonical document read/reset. A prior local PostgreSQL/sandbox-storage qualification passed 21 tests. | Served original cases **13–19, 40–46, 51, 72, 75 and CD-05**: actual authorized source/parser/current-version receipts and downloads, ordinary-role denial, approval failure/retry/reload, malformed/incomplete calls with zero effects, one logical effect in an owned sink. These are 17 numbered cases plus one CD case, not a total across all workstreams. |
| Workstream B / P1A–P1B | Canonical memory retrieval, current-owner source/handle validation, governed selection/procedures, source-family repairs and bounded withdrawal/revocation qualifications. | Original memory/scope/source/domain cases, **CD-01–07**, applicable **M** contracts; provider-exposed schemas and actual tool calls; old memory beyond 500; revocation at use/resume; complete discovery statuses with zero writes; filters, aliases, fiscal years, pagination and ordinary-tenant parity. Finish controlled fixture owners and sinks. |
| Workstream C / P1C | Plans, aggregate budgets, compaction, durable coordinator/UI, current-model children and local recovery/budget mechanisms. | Served **71–75** and **CW-01–08**: actual termination, stale-owner fencing, reconnect, ordered steering, Stop, ambiguous-effect reconciliation, retry/JEV/child budgets, source revocation and malformed/late child results. The roughly 600-second API stream wall can terminate while the orchestrator finishes; local tests do not establish live recovery/trace continuity. |
| Workstream D / P2 | Narrative/citation repairs, JEV policy retention and actual local OTEL exporter/span qualifications. A prior combined narrative qualification recorded 408 tests with exit 0. | Genuine paired outputs **52–58**, human rubric, explicit disposition of the **26 historical Appendix H findings**, served flags/model/budgets/tool exposure and full usage/cost. Qualify actual trace export, UI/API/runtime joins, replacement continuity, identity, access and retention. OTLP is disabled without endpoint configuration. |
| Final acceptance / handover | Original documents, source inventory, acquisitions, 26-case offline suite and frozen 75-case contract exist. | Complete capture/predicates/fixtures, authenticated acceptance under current policy, critical repeats, deterministic grading then saved-output human rubric, acquisition disposition and final release/rollback. Do not infer readiness from a migration alone. |

Defense **chat only** is excluded. Existing Meri Defense Budget / Program Elements / Research Portfolio cases remain. New File02/03 product expansion and optional CW-09–12 are outside this closeout unless explicitly added.

## Acceptance implementation gaps: exact source starting points

1. `evals/meri/live-v1/capture-transport.mjs` rejects `LIVE_CAPTURE` before conversation creation. Missing authoritative bindings include predispatch read-only/effect suppression, source/fixture/current version, served API/runtime build identity and cost reservation. `verify-capture.mjs` independently rejects live authority. Read the current guards and [capture policy qualification](../../implementation/capture-policy-manifest-binding-qualification.md); do not just remove the guards.
2. `evals/meri/live-v1/artifact-collector.mjs` separately rejects `LIVE_CAPTURE` with `LIVE_ARTIFACT_PATH_UNSAFE`. Its portable Node writer cannot pin every parent directory handle against path/reparse races. Supply and qualify a trusted artifact-storage boundary; solving capture signatures alone does not solve this gate.
3. `evals/meri/live-v1/deterministic-predicates.mjs` currently implements only **15/75** case predicates: `01,03,12,13,14,15,16,17,18,19,20,46,51,56,72`. Sixty return `implemented:false`; cases 40–45 require actual binary/parser/current-owner evidence. This is missing acceptance coverage, not 60 observed product defects.
4. `evals/meri/live-v1/fixture-provisioning/` has concrete memory candidate/retirement and client-document ownership paths. Other canonical owners and mail/Monday/action/coworker controlled adapters remain availability-dependent. Preserve immutable approvals/audit history and prove actual query isolation/retirement; a fresh namespace or hash alone is insufficient.
5. Actual authenticated UI/fault/effect capture and output grading are outstanding. Observe actual controls and canonical effects in owned sinks, use ordinary roles for denial, capture writes once and grade saved output. A signed receipt or model-supplied PASS label is insufficient. Current shared policy reserves production browser/canary tests for the user.

## Saved evidence, with limits

- Offline checkpoint at `c4da4c170e9c68f1a09ffa5c4832c7023c90b041`: shared/core builds, **53 Python tests**, **40 Node tests**, **Promptfoo 26/26**, verifier **26/26**, all exit 0. The aggregate report hash was `69d6768b2a4d0061d769f3f9e27f3e0fd0d4c931b51a0054feaf2e3e2e650032`. This was not live API/model/browser execution.
- Live-contract checkpoint at `3e2d0896164d04441d5ecfc1e506f8ca387cb71d`: contract75 valid, **185 tests passed / 3 skipped**, command exits 0. Generated case disposition: **PASS 0, FAIL 0, BLOCKED 0, NOT RUN 75**. Case source SHA-256 `acd2a1cf766ad6e988025c4c43235213164926e7036cc8361986916d59963b66`; fixture SHA-256 `2a8159d45d512f325539eb700907700ecc16cbc2d6536277adf85d8f49368e61`.
- Full-chat contract checkpoint: **22/22 offline tests**, exit 0; no flags or ECS task changed by that check.
- Raw host evidence is not published here. These are explicitly historical aggregate observations; use the versioned source/qualifications to reproduce safe checks and obtain new exact-head evidence. Do not transfer PASS to changed code or call the 75 NOT RUN cases passing/failing product behavior.

## Reading priority and corrections

Start from the [original plan](../../implementation/01-Meri-Foundation-and-Reliability.md), then the requirements, memory strategy acceptance and the relevant qualification files in `docs/meri/implementation`. Original uploaded Foundation file SHA-256 was `77c55b7484343a766c3bd17047c513b50c7c5d045e2018f03ea9dd0c08b622bd`; the versioned source/acquisition records preserve its lineage.

Older chronological status records saying "neither main" or "candidate held" predate later merges. Reconcile them against Git history rather than redo the implemented work. An older local Workstream A matrix mislabeled Appendix H findings as the original cases 13–19: the authoritative Appendix F cases 13–19 are memory proposal/approve/reject/permission/list/conflict/retry. Do not carry forward that numbering error.

M applicability is already documented in [01-memory-strategy-acceptance.md](../../implementation/01-memory-strategy-acceptance.md): M01/02/06 required; M03/04 at changed source/scheduler boundaries; M05/07–11 and M16–20 at changed narrative/runtime/review boundaries; M12/13 conditional on changed verified-draft editing; M14/15 later unless an existing structural-amendment path changed. Do not invent optional blockers or omit applicable contracts.

The first live priority slice after infrastructure and policy prerequisites is `01,12,14,17,20,46,51,72,74,CD-02,CD-05`. Full completion still requires the broader original scope, repeats, saved outputs, explicit limitations, release identity and owner acceptance.
