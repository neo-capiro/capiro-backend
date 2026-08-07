# Phase 7 Handoff — Canonical Promotion of Verified Defense-Budget Projections

## What Phase 6 leaves behind

Phase 6 ends with independently verified, noncanonical outputs for:

- HASC and SASC authorization marks;
- NDAA authorization conference;
- HAC-D and SAC-D appropriations marks;
- appropriations conference/JES;
- public-law enacted positions with explicit enactment proof;
- typed congressional actions and provisions;
- reprogramming actions/revised totals;
- execution metric records;
- proof-bound native-line bindings;
- deterministic cycle certification;
- optional audit-only projection rows.

The data model now distinguishes authorization, appropriations, enactment, reprogramming, and execution through the full lifecycle. Phase 6 does not write these projections into product truth.

## Phase 7's only job

Build the governed promotion mapper/repository that moves **verified Phase 6 projections** into canonical product tables after all required policy, verification, review, and transaction checks pass.

Do not re-extract, reinterpret, or re-resolve source facts inside Phase 7. Promotion consumes proof-bound Phase 6 projection rows.

## Required promotion inputs

Every position/action promotion candidate must retain:

- verification candidate ID;
- verification run ID;
- extraction artifact ID/content hash;
- SourceDocument ID/source PDF SHA;
- source-profile hash;
- native-identity hash/key;
- track/stage/field;
- direct/derived status;
- evidence IDs;
- binding status;
- projection status;
- enactment-proof ID for `enacted`;
- post-enactment metric/basis metadata when relevant;
- deterministic idempotency/natural key.

## Promotion eligibility

A Phase 7 mapper must reject anything that is:

- `candidate`, `blocked`, `superseded`, or `NEEDS_REVIEW`;
- bound by title-only similarity rather than accepted native identity;
- missing required comparison coverage;
- sourced from stale/superseded proof;
- using the wrong track/stage/field mapping;
- an `enacted` value without a complete enactment proof;
- a CR line position without explicit line authority;
- a reprogrammed total derived without explicit policy authorization;
- an execution record without an exact metric/as-of/cumulative profile;
- a conflicting live projection for the same natural key.

## Transaction design

Promotion should be one transaction per governed promotion batch:

1. re-read the projection and certification inside the transaction;
2. assert the proof/projection rows have not changed or been superseded;
3. assert exact natural-key uniqueness;
4. apply per-field source ownership;
5. write canonical positions/actions/provenance;
6. record the Phase 6 projection ID and verification IDs on canonical provenance;
7. persist a promotion receipt;
8. commit only after every row passes.

A partial batch must roll back completely.

## Idempotency

Exact replay of the same verified projection must be a no-op and return the existing promotion receipt. A different projection for the same live canonical natural key must be treated as a supersession/conflict workflow, never last-write-wins.

## Canonical stage fields

Maintain the Phase 6 ownership mapping exactly:

- `hasc` → `hascMark`
- `sasc` → `sascMark`
- `ndaa_conference` → `ndaaConference`
- `hac_d` → `hacDMark`
- `sac_d` → `sacDMark`
- `appropriations_conference` → `conference`
- `public_law` → `enacted`
- `reprogramming` → `reprogrammed`
- `execution` → `executed`

Request ownership remains with the President's Budget sources from earlier phases.

## Separate action promotion

Typed actions must not be flattened into stage totals. Phase 7 should promote them into the product's action/provision model with source scope, direction, transfer pairing, rationale, and evidence preserved. Never recompute a net action to manufacture a funding position.

## Enactment promotion

The promotion receipt for every `enacted` row must reference its `DefenseBudgetEnactmentProofV1`. Conference/JES amounts are not enacted merely because they equal the public-law outcome.

## Post-enactment promotion

Reprogramming and execution remain semantically distinct:

- transfer actions are action records;
- revised totals are `reprogrammed` positions only when explicitly supported;
- obligations/outlays/etc. remain exact metric records;
- `executed` is only the profile-declared mapped metric.

## Phase 7 acceptance baseline

Before implementing canonical writes, run the complete Phase 6 closeout and pin its accepted Git SHA. Phase 7 must keep the Phase 6 negative controls green. Any canonical writer added to Phase 6 paths is a regression.

Recommended first Phase 7 workstreams:

1. promotion contract and receipt schema;
2. read-only canonical diff/planner;
3. transactional promotion repository;
4. RDT&E promotion;
5. procurement/O&M/MILCON promotion;
6. action/provision promotion;
7. enactment and post-enactment promotion;
8. idempotency/supersession/rollback controls;
9. production rollout and recovery runbook.
