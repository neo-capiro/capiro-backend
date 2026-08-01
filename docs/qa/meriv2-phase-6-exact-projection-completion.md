# MeriV2 Phase 6 Acceptance — Exact Projection Completion

**Repository:** `neo-capiro/capirov2`  
**PR:** `#679`  
**Branch:** `agent/meriv2-world-class-closeout`  
**Final audited runtime head:** `3e4a20146cc4f1dda10070b7eac76f73d8b7885b`  
**Moving baseline:** `main@3dcb12f823774b6fae8578dc56fc122bf9a0879e`

## Acceptance result

**PASS.** Phase 6 is fully closed at the code-level acceptance boundary defined by the
MeriV2 closeout plan.

Every covered request-time and scheduled indexing path now carries an exact durable
obligation before returning. A job can become `completed` only after the expected Clio
source version, canonical `memory_items` target, canonical content hash, and required
embedding state are proven. Obsolete work terminates as `superseded`; failed or partial
work remains retryable or reaches bounded dead-letter state.

## Final-audit finding and correction

The first Phase 6 implementation bound an index obligation to:

- tenant;
- Clio source ID;
- source `updated_at` version; and
- canonical content hash stored in separate outbox columns.

However, its **unique idempotency key** contained only the source ID and timestamp. At
the application boundary, timestamps have finite precision, so two serialized rapid
mutations could share one timestamp while producing different canonical hashes. The
second `INSERT ... ON CONFLICT DO NOTHING` could therefore collapse into the first job.
If the first job then became `superseded`, the latest content could have no remaining
obligation.

The final audit closes that gap. New index job keys are now deterministically bound to:

```text
index_memory_item:<clio-memory-id>:<source-version>:<expected-content-hash>
```

Both request-time and scheduled paths independently recompute and verify this binding.
A malformed or legacy-unbound key fails closed and cannot reach the projector or be
marked complete. Regression coverage proves that two different hashes remain distinct
even when their source timestamps are identical.

## Runtime contract proven

### Live provider ownership

`MemoryModule` resolves the public service tokens to:

- `GovernedMemoryIngestService` for request-time projection;
- `ExactMemoryCleanupOutboxService` for durable obligation creation and bookkeeping;
- `ExactMemoryProjectionWorkerService` for scheduled processing; and
- one shared `StrictMemoryProjectorService` for projection and verification semantics.

The inherited best-effort classes remain explicit rollback implementations but are not
the live injected path.

### Exact durable job identity

Every new `index_memory_item` row binds:

- exact outbox job ID;
- tenant and Clio source ID;
- authoritative canonical item ID when one already exists;
- exact source version;
- exact canonical normalized-content hash; and
- a deterministic idempotency key containing the source ID, version, and hash.

The obligation is inserted in the same transaction as the source mutation. Reviewed
candidates bind to the already-created authoritative governed item instead of creating
a second compatibility projection.

### Strict projection receipt

`StrictMemoryProjectorService.projectClioMemoryStrict()`:

1. loads the tenant-scoped Clio source;
2. compares the captured source version;
3. resolves the expected authoritative item or creates the stable compatibility item;
4. computes the canonical normalized embedding text and hash;
5. writes the embedding outside the claim transaction;
6. rechecks the source after network work;
7. verifies the exact canonical item and exact embedding content hash; and
8. returns only `projected`, `vanished`, or `superseded` with bounded identity metadata.

Provider, projection, canonical-content, or embedding failures throw. They cannot be
converted into `completed`.

### Request-time completion

The request-time path first loads the newest exact pending/failed job. It validates that
the stored idempotency key matches the source ID, captured version, and captured hash,
passes the full expectation to the strict projector, verifies the returned receipt, and
updates only the exact job ID and exact binding.

It fails closed when:

- no exact durable job exists;
- the key is not bound to the captured version and hash;
- the projector throws;
- the receipt does not match the expectation; or
- the receipt lacks required identity metadata.

The legacy broad index-completion method is a no-op on the live exact outbox provider.

### Scheduled completion

The permanent worker retains:

- bounded batches;
- `FOR UPDATE SKIP LOCKED` claims;
- opaque expiring leases;
- stale-lease recovery;
- bounded exponential backoff;
- terminal dead-letter state; and
- network work outside the claim transaction.

For index jobs it additionally validates the source/version/hash idempotency binding,
passes the exact canonical target to the strict projector, and updates terminal state by
exact job ID plus current lease owner. A stale version becomes `superseded`; it cannot
acknowledge a newer job.

## Additive schema

Committed migration:

`apps/api/prisma/migrations/20260812030000_memory_projection_exact_completion/migration.sql`

It adds:

- `expected_source_version`;
- `expected_content_hash`;
- `superseded_at`;
- exact-job indexes; and
- the additive `superseded` terminal status.

The expectation constraint is initially `NOT VALID` so pre-existing Phase 5 jobs are
preserved for Phase 18 inventory and rehearsal rather than silently deleted or rewritten.

**No migration was applied to a shared or production environment.**

## Final audited validation

All validation below passed on runtime head
`3e4a20146cc4f1dda10070b7eac76f73d8b7885b`:

- all five Prisma clients generated;
- full repository dependency-graph typecheck — **PASS**;
- projection-worker infrastructure typecheck — **PASS**;
- API governed-memory matrix — **54 suites / 468 tests PASS**;
- orchestrator Context/Strategy/Steward matrix — **4 suites / 24 tests PASS**;
- Workspace canonical-context matrix — **4 suites / 32 tests PASS**;
- Settings shared-memory web contract — **1 file / 2 tests PASS**.

**Cumulative total: 63 suites/files and 526 tests, all passing.**

Required workflows on the audited runtime head:

- `memory-governance-ci` run `30573128340` — **PASS**;
- `ci-pr` run `30573128182` — **PASS**;
- `meriv2-evals` run `30573128462` — **PASS**;
- `engagement-trust-boundary` run `30573128419` — **PASS**;
- `legiwatch-ci` run `30573128193` — **PASS**;
- `funding-opportunities-ci` run `30573128184` — **PASS**.

The final acceptance-evidence commit itself must also pass these six workflows before
Phase 7 begins. Its exact SHA and final run IDs are recorded in PR #679 after that gate.

## Required regression coverage

The permanent suite proves:

- projector exceptions leave exact jobs retryable;
- two different content hashes create distinct obligations even with the same timestamp;
- request-time and scheduled paths reject keys not bound to both version and hash;
- an old request cannot complete a newer queued version;
- canonical item ID and embedding target must match;
- canonical and embedding hashes must match;
- source changes during processing produce `superseded`;
- missing canonical projection or embedding cannot produce `completed`;
- vanished sources close only the exact known job;
- missing durable jobs fail closed;
- legacy jobs without exact expectations do not disappear;
- terminal worker updates require exact job and lease identity; and
- no broad `clio_memory_id` completion remains on the live index path.

## Moving-main and review state

At the final runtime audit boundary, the branch was **0 commits behind**
`main@3dcb12f823774b6fae8578dc56fc122bf9a0879e`. The audit patch changed six memory
projection implementation/test files only. It did not modify Program Element,
defense-budget, engagement, funding, or LegiWatch runtime behavior.

PR #679 had no inline review threads and no submitted reviews at this boundary. It
remains draft, mergeable, and unmerged.

## Rollback

If the exact-completion path must be withdrawn before rollout:

1. keep all governed-memory, Context Packet, and release flags dark;
2. pause the projection EventBridge rule before rolling worker code backward;
3. restore the Phase 5 provider/entrypoint bindings through normal forward commits;
4. preserve additive schema, immutable versions, candidates, audits, pending jobs,
   completed jobs, superseded jobs, failed jobs, and dead-letter jobs;
5. never hand-complete or bulk-delete obligations by `clio_memory_id`; and
6. do not use a destructive down migration as the primary rollback.

## Safety statement

No merge to `main`, AWS deployment, shared or production migration application,
production backfill, feature-flag activation, customer-data mutation, external send, or
production operation occurred during this audit.

**Next gated phase:** Phase 7. Phase 7 must not begin until the acceptance-evidence
commit itself is synchronized with moving `main` and all six required workflows pass on
that final SHA.
