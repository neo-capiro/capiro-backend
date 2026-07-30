# MeriV2 Phase 6 — Exact, Failure-Aware Projection Completion

## Decision

**PASS.** Phase 6 is complete at the code-level acceptance boundary defined by the
MeriV2 closeout plan.

Repository: `neo-capiro/capirov2`  
Branch: `agent/meriv2-world-class-closeout`  
Draft PR: `#679`  
Implementation validation SHA: `67288bb76ed0a02a7cc4e56f191b27847483dd3a`

## Closed audit item

Projection failures can no longer be swallowed while an indexing obligation is marked
complete, and neither the request-time fast path nor the scheduled worker can complete
all jobs associated with a `clio_memory` row.

## Implemented contract

### Exact durable job identity

Every new `index_memory_item` outbox row binds:

- outbox job ID;
- tenant and Clio source ID;
- canonical `memory_items` ID when one already exists;
- deterministic idempotency key;
- exact `clio_memory.updated_at` source version;
- SHA-256 of the canonical normalized embedding text.

The source version and canonical content hash are captured inside the source mutation
transaction. Reviewed candidates bind the job to the authoritative governed item rather
than creating a second compatibility item.

### Strict projector receipt

`StrictMemoryProjectorService.projectClioMemoryStrict()` throws on projection or
embedding failure and returns a receipt only after it can prove the exact effect. The
receipt records the outcome, job binding, source version, content hash, canonical item
ID, and whether an embedding was required.

Completion requires:

- the expected source version still matches;
- the exact canonical item exists;
- canonical content hashes to the expected value;
- the embedding targets the exact canonical item ID;
- the stored embedding content hash matches the expected value.

If the source advances during processing, the old obligation becomes `superseded`; it
is not treated as successful completion of the newer job.

### Request-time fast path

The live `MemoryIngestService` token resolves to `GovernedMemoryIngestService`. Before
projecting, it loads the exact pending/failed durable job and passes that job's complete
expectation to the strict projector. It then updates only that job ID and exact binding.

A missing exact job fails closed. A projector exception leaves the durable row pending
or failed for the scheduled worker. The inherited best-effort projector remains exposed
only as the explicit code rollback path.

### Scheduled worker

The permanent drain entrypoint now uses `ExactMemoryProjectionWorkerService`. It
preserves the Phase 5 lease, `FOR UPDATE SKIP LOCKED`, bounded batch, stale-lease,
backoff, and dead-letter behavior while adding:

- exact expected version/hash/item validation;
- exact job ID and lease-token terminal updates;
- receipt-binding verification;
- terminal `superseded` classification for obsolete jobs;
- fail-closed treatment of pre-expectation legacy rows.

No embedding call runs inside a database transaction.

## Additive schema

Committed migration:

`apps/api/prisma/migrations/20260812030000_memory_projection_exact_completion/migration.sql`

It adds `expected_source_version`, `expected_content_hash`, `superseded_at`, exact-job
indexes, and the additive `superseded` terminal status. The expectation check is added
`NOT VALID` so existing Phase 5 rows are not silently deleted or rewritten before the
Phase 18 database rehearsal and rollout inventory.

**The migration was not applied to any shared or production environment.**

## Acceptance evidence

All validation below passed on
`67288bb76ed0a02a7cc4e56f191b27847483dd3a`:

- full repository dependency-graph typecheck — **PASS**;
- Phase 5 CDK worker infrastructure typecheck — **PASS**;
- API governed-memory matrix — **54 suites / 466 tests PASS**;
- MeriV2 orchestrator, Strategy, and Steward matrix — **4 suites / 24 tests PASS**;
- Workspace canonical-context matrix — **4 suites / 32 tests PASS**;
- Settings shared-memory contract — **1 file / 2 tests PASS**.

**Total: 63 suites/files and 524 tests, all passing.**

Required GitHub workflows:

- `memory-governance-ci` run `30568469244` — **PASS**;
- `ci-pr` run `30568470148` — **PASS**;
- `meriv2-evals` run `30568467688` — **PASS**;
- `engagement-trust-boundary` run `30568467664` — **PASS**;
- `legiwatch-ci` run `30568468065` — **PASS**;
- `funding-opportunities-ci` run `30568467924` — **PASS**.

## Required regression coverage

The permanent suite proves:

- projector exception leaves the exact job retryable;
- an old request cannot complete a newer queued version;
- canonical item ID and embedding ID must match;
- canonical and embedding content hashes must match;
- source change during processing produces `superseded`;
- missing canonical projection or embedding cannot produce `completed`;
- a vanished source closes only its exact known job;
- a missing durable job fails closed rather than guessing a projection target;
- legacy jobs without exact expectations do not disappear;
- request-time and scheduled terminal updates bind exact job and lease identity;
- no broad `clio_memory_id` completion remains on the live index path.

## Rollback

If Phase 6 code must be rolled back before enforcement:

1. disable request-time exact completion and rely on the durable scheduled worker;
2. restore the Phase 5 provider/entrypoint bindings without deleting queued rows;
3. leave additive schema, audit evidence, completed jobs, superseded jobs, pending jobs,
   and dead-letter rows intact;
4. never bulk-complete or delete obligations by `clio_memory_id`;
5. do not run a destructive down migration as the primary rollback.

## Safety statement

No merge to `main`, production deployment, shared-environment migration application,
production backfill, feature-flag activation, AWS operation, external send, or customer
data mutation was performed.

**Next gated phase: Phase 7 — truthful Context Packet persistence.**
