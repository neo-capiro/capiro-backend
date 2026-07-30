# MeriV2 Phase 6 Acceptance — Exact Request-Time Projection Completion

**Repository:** `neo-capiro/capirov2`  
**PR:** `#679`  
**Branch:** `agent/meriv2-world-class-closeout`  
**Accepted code head:** `67288bb76ed0a02a7cc4e56f191b27847483dd3a`  
**Moving baseline at acceptance:** `main@3dcb12f823774b6fae8578dc56fc122bf9a0879e`

## Acceptance result

**PASS.** Every request-time memory projection path covered by the Phase 6 surface now leaves an exact-version durable obligation before returning. A completion is recorded only after the expected Clio source version, canonical `memory_items` projection, content hash, and required embedding state are proven. Newer source versions supersede stale work instead of allowing an older obligation to acknowledge them.

## Runtime contract proven

- `MemoryModule` owns the live provider selection for request-time ingestion, outbox completion, and scheduled projection work.
- The governed request-time adapter delegates to the single strict projector rather than reimplementing projection semantics.
- Every `index_memory_item` obligation carries exact source-version and content-hash identity.
- Fast-path completion selects one exact pending/failed obligation and cannot close another version, tenant, operation, or memory.
- Strict projection returns an explicit receipt (`projected`, `vanished`, or `superseded`) with bounded identity metadata and no memory body.
- The scheduled worker uses bounded batches, `FOR UPDATE SKIP LOCKED`, opaque expiring leases, stale-lease recovery, bounded retry/backoff, and terminal dead-letter handling.
- Projector/network work runs outside the database claim transaction.
- A source deleted during projection is treated as an idempotent vanished result; a source changed during projection supersedes the stale obligation.
- Completion requires the current lease owner plus exact job identity and cannot report partial canonical or embedding work as complete.
- Persisted/logged errors are bounded reason codes and never prompts, memory bodies, generated content, provider payloads, secrets, or email bodies.
- The schema change is additive and committed only; no migration was applied to any shared or production environment.

## Validation

Permanent cumulative workflow `memory-governance-ci` run `30568469244` passed on the exact accepted code head:

- all five Prisma clients generated;
- full repository dependency-graph typecheck — PASS;
- Phase 5/6 worker infrastructure typecheck — PASS;
- API governed-memory matrix — **54 suites / 472 tests PASS**;
- orchestrator Context/Strategy/Steward matrix — **4 suites / 24 tests PASS**;
- Workspace canonical-context matrix — **4 suites / 32 tests PASS**;
- Settings shared-memory web contract — **1 file / 2 tests PASS**.

Cumulative total: **63 files/suites and 530 tests, all passing**.

Required normal PR workflows on `67288bb7`:

- `memory-governance-ci` `30568469244` — **PASS**;
- `ci-pr` `30568469279` — **PASS**;
- `meriv2-evals` `30568469270` — **PASS**;
- `engagement-trust-boundary` `30568469267` — **PASS**;
- `legiwatch-ci` `30568469277` — **PASS**;
- `funding-opportunities-ci` `30568469288` — **PASS**.

## Moving-main and Program Element safety

Immediately before recording this acceptance gate, the closeout branch was **0 commits behind** `main@3dcb12f823774b6fae8578dc56fc122bf9a0879e`. Phase 6 changed memory governance, its additive migration, tests, and the cumulative workflow only. It did not modify Program Element or defense-budget runtime files. Current-main Program Element behavior remains authoritative and unchanged.

## Rollback

- Keep all governed-memory, Context Packet, and release flags dark.
- Roll application/task definitions back to the Phase 5 provider bindings if the exact-completion path must be withdrawn.
- Preserve additive schema, immutable memory versions, audit records, candidates, and outbox rows; do not run a destructive down migration.
- Pause the memory projection EventBridge rule before rolling worker code backward if compatibility must be inspected.
- Do not mark pending exact-version obligations complete by hand, reopen terminal memory rows, or activate pending shared candidates.

No merge to `main`, AWS deployment, migration application, production backfill, feature-flag activation, customer-data mutation, or external send occurred during Phase 6.

**Next gated phase:** Phase 7. Phase 7 must not begin until the acceptance-evidence commit itself is synchronized with moving `main` and all required PR checks run successfully on that final SHA.
