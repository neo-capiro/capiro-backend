# MeriV2 World-Class Closeout — Work Log

**Repository:** `neo-capiro/capirov2`  
**Primary branch:** `agent/meriv2-world-class-closeout`  
**Primary PR:** `#679`  
**State:** Draft, unmerged  
**Authoritative through:** Phase 6 code acceptance  
**Latest accepted code head:** `67288bb76ed0a02a7cc4e56f191b27847483dd3a`  
**Moving baseline at the Phase 6 acceptance check:** `main@3dcb12f823774b6fae8578dc56fc122bf9a0879e`

No merge to `main`, AWS deployment, shared/production migration, production backfill, feature-flag activation, customer-data mutation, or external send has occurred during Phases 0–6.

---

## Operating ledger

The closeout branch is treated as published history. Synchronization uses ordinary merge commits; no force-push or rebase of the published branch is allowed. Before each phase, promotion, and acceptance gate, current `main` is re-read and current-main behavior wins any overlap. Program Element and defense-budget work is outside the MeriV2 closeout boundary and must remain unchanged unless an exact MeriV2 control requires a narrow additive overlap.

Release-blocking invariants:

- browser-supplied tenant, role, ethical-wall, approval, policy, context-health, and assurance claims are never trusted;
- firm/client memory is immutable and independently reviewed;
- correctness/auditability work is transactional or durably queued;
- terminal memory rows are never reopened;
- logs and metrics contain bounded IDs/statuses/hashes/reason codes/counts/timestamps only;
- no phase advances until its acceptance gate passes on a synchronized head.

---

## Phase 0 — branch synchronization and executable baseline

### Result

**PASS.** The closeout branch was synchronized with moving `main` without rewriting public history. The sole dispatcher conflict was resolved as a verified current-main-first superset. Current-main District Nexus and Program Element behavior was retained.

### Evidence

- synchronization merge: `21786e16f7235f31108fee770b9b403316df7e33`;
- PR #679 remained draft, mergeable, and unmerged;
- no production action occurred.

---

## Phase 1 — atomic candidate activation

### Runtime contract

Candidate approval now executes one server-owned tenant transaction that:

1. locks the pending candidate;
2. derives and authorizes the real actor/effective context;
3. enforces independent review for shared memory;
4. creates/updates canonical Clio and governed memory state;
5. records candidate decision and exact lineage;
6. writes transition evidence;
7. enqueues the required projection obligation;
8. commits or rolls every mutation back together.

Personal immediate activation and rejection use the same transaction boundary. Concurrent approvals serialize and only one can decide a pending candidate.

### Evidence

- implementation: `dd4ce36e47b0566a53c5f98695c630a1920962aa`;
- targeted matrix: **6 suites / 43 tests PASS**;
- normal required workflows on the Phase 1 evidence head: all PASS.

### Acceptance

**PASS.** No successful path can activate canonical memory while leaving the candidate pending, and no candidate can commit without canonical state, transition evidence, and its durable projection obligation in the same transaction.

---

## Phase 2 — canonical governed-memory activation

### Runtime contract

Approved candidates write authoritative governed metadata to the active `memory_items` version inside the Phase 1 transaction. Candidate lineage is stable through `source_version=candidate:<id>` and exact `committed_memory_item_id`. Pending memory is withheld. Approved item identity and authority remain consistent through Clio compatibility projection and Context Packet consumers across API, orchestrator, Strategy, Steward, and Workspace.

### Evidence

- implementation: `36b0a991f6b5f67efe2db41a29e039d1897285cd`;
- validation matrix: API **10 suites / 88 tests**, orchestrator/Strategy/Steward **4 suites / 24 tests**, Workspace **2 suites / 13 tests**, all PASS;
- all required normal workflows PASS.

### Acceptance

**PASS.** Approved governance is canonical, tenant-scoped, provenance-preserving, and atomically consistent with candidate, audit, Clio, and outbox state.

---

## Phase 3 — Settings shared-memory review lifecycle

### Runtime contract

Firm/client Settings edits resolve actor, scope, client, and ethical-wall state on the server and create complete-state review candidates. Active controlling content remains unchanged while review is pending. First-time shared files create candidates only. Personal files retain immediate owner-only saves. Reload exposes truthful pending state, and the UI says “Submitted for independent review,” never “Saved.”

### Evidence

- runtime implementation: `51bcb642851bbfcdc452908c94a830afd6a07733`;
- API matrix: **5 suites / 31 tests PASS**;
- web result contract: **1 file / 2 tests PASS**;
- Program Element forbidden-path assertion PASS;
- all required normal workflows PASS.

### Acceptance

**PASS.** No Settings route can directly change active firm/client steering context; shared proposals remain review-gated and personal files remain immediate and owner-only.

---

## Phase 4 — immutable corrections, restores, duplicates, and conflicts

### Runtime contract

- personal correction creates a new private active version and supersedes the prior version transactionally;
- firm/client correction and restore create independently reviewed candidates while the current controlling version remains active;
- revoked/superseded rows are never reopened;
- approval creates a new version and supersedes exactly the controlling predecessor in the Phase 1 transaction;
- exact duplicates link/confirm existing truth instead of creating a new controlling row;
- contradictions create a conflict group, retain both versions, and withhold noncontrolling claims until explicit resolution;
- legal hold, expiry, target lineage, tenant isolation, and ethical walls fail closed.

### Evidence

- cumulative Phase 4 validation head: `860bc2acde8a90f4a8e43e573a09a9135d114681`;
- API matrix: **45 suites / 409 tests PASS**;
- orchestrator matrix: **4 suites / 24 tests PASS**;
- Workspace matrix: **4 suites / 32 tests PASS**;
- Settings web contract: **1 file / 2 tests PASS**;
- cumulative total: **54 files/suites / 467 tests PASS**;
- all required workflows PASS.

### Acceptance

**PASS.** Corrections/restores preserve immutable history and cannot replace shared controlling truth without independent review. Duplicate, contradiction, legal-hold, expiry, and lineage invariants hold.

---

## Phase 5 — scheduled failure-aware projection/index worker

### Runtime contract

- `index_memory_item` is a durable obligation committed with the memory write;
- the scheduled worker claims bounded batches with `FOR UPDATE SKIP LOCKED` and opaque expiring leases;
- projection and embedding run outside the claim transaction;
- strict projection awaits canonical upsert and embedding and verifies both before completion;
- source edits/deletes during work cannot mark stale content complete;
- completion/failure requires the current lease owner;
- retries use bounded exponential backoff and exhausted work becomes observable dead-letter state;
- worker logs persist bounded codes, never memory bodies or provider responses;
- the CDK worker stack supplies EventBridge scheduling, scoped DB/Bedrock access, logs, metrics, and alarms.

### Evidence

- Phase 5 code-bearing acceptance SHA: `0f5ded51aaa74a74e09fc26256469eee263ee4ea`;
- cumulative validation SHA: `8fdcd83aeac66f37e61c57a962ce969f1d6de2ac`;
- API governed-memory matrix: **50 suites / 445 tests PASS**;
- orchestrator matrix: **4 suites / 24 tests PASS**;
- Workspace matrix: **4 suites / 32 tests PASS**;
- Settings web contract: **1 file / 2 tests PASS**;
- cumulative total: **59 files/suites / 503 tests PASS**;
- `memory-governance-ci` `30556617455` and all five normal required workflows PASS.

### Acceptance

**PASS.** Failed fast-path work cannot disappear, concurrent workers cannot own one live lease, stale claims recover, exhausted jobs are observable, and completion requires durable canonical and embedding state.

---

## Phase 6 — exact request-time projection completion

### Accepted code head

`67288bb76ed0a02a7cc4e56f191b27847483dd3a`

### Runtime contract

- `MemoryModule` owns the live bindings for governed request-time ingestion, exact outbox completion, and the scheduled exact projection worker;
- the request-time adapter delegates to the single strict projector rather than duplicating projection semantics;
- each indexing obligation is tied to the exact Clio source version, expected content hash, tenant, operation, and idempotency identity;
- fast-path completion cannot close another version or another memory’s obligation;
- strict projection returns an explicit `projected`, `vanished`, or `superseded` receipt;
- a source that changes during projection supersedes the stale obligation; a source that vanishes completes idempotently without resurrecting state;
- canonical and embedding evidence must both exist before success is recorded;
- scheduled claims use `FOR UPDATE SKIP LOCKED`, expiring leases, stale-lease recovery, bounded retries, and terminal dead-letter handling;
- projector/network work runs outside the database claim transaction;
- completion requires exact job identity and current lease ownership;
- all persisted/logged failures are bounded reason codes with no prompts, memory bodies, generated content, secrets, provider payloads, or email bodies;
- Phase 6 schema changes are additive and remain unapplied in every shared/production environment.

### Acceptance evidence

On synchronized code head `67288bb7`, permanent cumulative workflow `memory-governance-ci` run `30568469244` passed:

- all five Prisma clients generated;
- full repository dependency-graph typecheck PASS;
- worker infrastructure typecheck PASS;
- API governed-memory matrix — **54 suites / 472 tests PASS**;
- orchestrator Context/Strategy/Steward matrix — **4 suites / 24 tests PASS**;
- Workspace canonical-context matrix — **4 suites / 32 tests PASS**;
- Settings shared-memory web contract — **1 file / 2 tests PASS**.

Cumulative total: **63 files/suites / 530 tests PASS**.

Required normal workflows on `67288bb7`:

- `memory-governance-ci` `30568469244` — **PASS**;
- `ci-pr` `30568469279` — **PASS**;
- `meriv2-evals` `30568469270` — **PASS**;
- `engagement-trust-boundary` `30568469267` — **PASS**;
- `legiwatch-ci` `30568469277` — **PASS**;
- `funding-opportunities-ci` `30568469288` — **PASS**.

Immediately before this acceptance record, the branch was **0 commits behind** `main@3dcb12f823774b6fae8578dc56fc122bf9a0879e`. Phase 6 modified memory-governance code, its additive migration, tests, and cumulative CI only; it did not change Program Element or defense-budget runtime files.

### Acceptance

**PASS.** Every covered request-time caller durably owes exact-version projection work before returning, and no completion path can acknowledge stale, partial, cross-version, cross-tenant, or unembedded state.

### Rollback posture

- keep governed-memory, Context Packet, and release flags dark;
- roll application/task definitions back to the Phase 5 provider bindings if exact completion must be withdrawn;
- preserve additive schema, candidates, immutable versions, audit rows, and outbox obligations;
- pause the projection EventBridge rule before a worker rollback when compatibility needs inspection;
- do not run destructive down migrations, hand-complete pending work, reopen terminal memory rows, or activate pending shared candidates.

Detailed acceptance: `docs/qa/meriv2-phase-6-exact-projection-completion.md`.

---

## Cumulative Phases 1–6 closure

### Closure result

**PHASES 1–6 CUMULATIVE CODE ACCEPTANCE: PASS.**

Later phases have not invalidated atomic activation, canonical governance propagation, Settings review, immutable correction/restore semantics, or durable projection/index behavior. The permanent cumulative workflow now proves all Phase 1–6 memory tests and cross-surface context adapters on one exact head.

### Deferred boundaries

These remain later-phase or release-certification work and do not reopen Phases 1–6:

- Phase 7 and later live-path context, persistence, assurance, policy, UX, migration-rehearsal, browser, SOC 2, and rollout gates;
- disposable-PostgreSQL clean replay, production-equivalent upgrade, rollback, RLS/FORCE, and concurrency proof;
- authenticated browser, narrow-width, and keyboard acceptance;
- production migration, backfill, deployment, and feature-flag activation.

**Next gated phase: Phase 7.** Do not begin Phase 7 until this Phase 6 acceptance-evidence commit is synchronized with moving `main` and all required PR checks run successfully on that final SHA.
