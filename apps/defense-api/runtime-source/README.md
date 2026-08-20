# Phase 1–7 trusted runtime source mirror

This directory is the Phase 8 Session 4 strangler copy of the accepted defense-budget runtime lineage. The copied trees are byte-identical Git trees from `apps/api`; `scripts/verify-phase8-session4.mjs` fails if either side drifts.

It is deliberately outside `src/` so the dark HTTP image does not accidentally compile infrastructure-bound Prisma, S3, parser-process, promotion-execution, or historical operator adapters into its request path. The compiled composition boundary lives in `apps/defense-api/src/runtime`.

## Included lineage

- defense-budget contracts, parser routing, semantic extractors, verification, stage composition, projection planning, Phase 6 certification, Phase 7 eligibility and inspect planning;
- Program Element snapshot, source-document, delta and outbox lineage needed by the trusted pipeline;
- read-only/inspect operator entrypoints for Phase 6 composition and Phase 7 planning/status.

## Deliberately excluded from the HTTP task

- canonical promotion execution and snapshot activation credentials;
- deterministic parser worker process ownership;
- NVIDIA/GPU runtime;
- schema migration authority;
- production schedules or traffic routing.

The original `apps/api` source remains during the strangler period. Deletion is forbidden until later shadow, canary, rollback and decommission acceptance.
