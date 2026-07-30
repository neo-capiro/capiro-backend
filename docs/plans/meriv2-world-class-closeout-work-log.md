# MeriV2 World-Class Closeout — Authoritative Work Log

Traceability ledger for draft PR **#679** on branch
`agent/meriv2-world-class-closeout`.

This document is the authoritative current-state record through Phase 5. Earlier
interim inventories and blocker notes remain preserved in Git history and PR comments,
but are superseded where this ledger records a later accepted implementation.

> No merge to `main`, production deployment, production migration application,
> backfill, feature-flag activation, AWS operation, external send, or customer-data
> mutation was performed during Phases 0–5 or their cumulative validation.

---

## Current branch and release posture

- Repository: `neo-capiro/capirov2`
- Branch: `agent/meriv2-world-class-closeout`
- Primary PR: `#679`
- PR posture: **draft and unmerged**
- Current synchronized baseline at the Phase 5 validation boundary:
  `main@3dcb12f823774b6fae8578dc56fc122bf9a0879e`
- Current-main synchronization merge:
  `6c8f32d946388a2a1e0b7f3233a2e80a26de9a3a`
- Cumulative Phase 1–5 validation SHA:
  `8fdcd83aeac66f37e61c57a962ce969f1d6de2ac`

The branch was zero commits behind `main` at the cumulative validation boundary. The
synchronization preserved current-main District Nexus/facility-geocoding behavior and
the Funding Opportunities migration-ordering guard. No Program Element or
defense-budget file required conflict resolution.

---

## Phase 0 — baseline, branch safety, and evidence capture

### Completed controls

- Captured the pre-existing branch state before modifying it.
- Preserved previously uncommitted work in commit `4019c5e2` before synchronization.
- Merged moving `main` without rewriting public branch history.
- Reconciled the entrypoint-dispatcher conflict as a verified union of both branches'
  command sets.
- Generated all five Prisma clients and established package/typecheck baselines.
- Recorded the original open-gap inventory before implementation.

### Acceptance

**PASS.** The branch was synchronized without losing in-flight work or current-main
behavior, and the implementation phases began from a traceable baseline.

---

## Phase 1 — atomic candidate activation

### Implementation

- Primary implementation:
  `dd4ce36e47b0566a53c5f98695c630a1920962aa`
- Final Phase 1 evidence head included formatting and cross-stream CI repairs through
  `dd3f806cae2d47019eed1a686c2b46e0acc5cc15`.

### Runtime contract

Candidate approval now executes one server-owned, tenant-scoped transaction that:

1. locks the candidate with `FOR UPDATE`;
2. verifies the candidate remains pending;
3. derives and authorizes the actual actor and effective tenant context;
4. enforces independent review for shared memory;
5. creates or updates the canonical Clio compatibility row;
6. records committed memory lineage on the candidate;
7. writes the terminal candidate decision;
8. writes transition evidence when lifecycle auditing is armed;
9. enqueues the durable projection/index obligation; and
10. commits or rolls every mutation back together.

Personal immediate activation and rejection use the same transaction boundary. A
separate controller authorization preflight no longer races the mutation.

### Acceptance evidence

- API typecheck — **PASS**.
- Targeted Phase 1 matrix — **6 suites / 43 tests PASS**.
- Required workflows on the accepted Phase 1 evidence head — **PASS**.

Covered scenarios include concurrent approval serialization, complete rollback after a
post-mutation failure, terminal-state rejection, cross-tenant nondisclosure, atomic
personal activation, and shared self-review denial.

### Acceptance

**PASS.** No successful path can leave canonical memory active while the candidate
remains pending, and candidate, memory, transition evidence, and outbox obligation
share one transaction.

---

## Phase 2 — canonical governed `memory_items` activation

### Implementation

- Runtime implementation:
  `36b0a991f6b5f67efe2db41a29e039d1897285cd`
- Accepted Phase 2 closeout SHA:
  `1ebc9ce312f7ce02de8b8340b10722621d9b25f0`

### Runtime contract

- Candidate approval creates or updates the authoritative governed `memory_items`
  version inside the Phase 1 transaction.
- Exact `committed_memory_item_id` lineage is persisted.
- Firm, client, and personal approvals map to canonical `playbook`,
  `client-compass`, and `user-profile` identities.
- Human-reviewed model extraction maps to `analyst_verified`; an unreviewed machine
  path remains `model_inferred`.
- The Clio row carries the same candidate lineage and governance envelope as a
  compatibility projection.
- Context Packet v2 includes approved canonical memory with the same item ID and
  authority and withholds pending memory.

### Acceptance evidence

Validation workflow `30518247413` passed:

- API Phase 1–2 matrix — **10 suites / 88 tests**;
- orchestrator Context v2, Strategy, and Steward matrix — **4 suites / 24 tests**;
- Workspace canonical-context matrix — **2 suites / 13 tests**;
- required package typechecks, including the Program Element safety verifier.

Required PR workflows on `1ebc9ce3` all passed:

- `ci-pr` `30518878323`;
- `meriv2-evals` `30518878319`;
- `engagement-trust-boundary` `30518878318`;
- `legiwatch-ci` `30518878324`;
- `funding-opportunities-ci` `30518878326`.

### Acceptance

**PASS.** Approved governance is authoritative on the active canonical item and remains
consistent across API, Clio compatibility projection, Context Packet v2, Strategy,
Steward, and Workspace while rolling back atomically with candidate/audit/outbox state.

---

## Phase 3 — Settings shared-memory review lifecycle

### Implementation

- Runtime implementation:
  `51bcb642851bbfcdc452908c94a830afd6a07733`
- Final Phase 3 runtime/scaffold-cleanup SHA:
  `a3f406388cbf65d9e3ab4e023325f2711eaefe4a`

### Runtime contract

- Personal files retain the immediate owner-only save path.
- Firm and client Settings edits resolve actor, scope, client, and ethical-wall state
  on the server and create complete-state review candidates.
- A first shared file creates a candidate only; it does not create an active orphan.
- Independent approval activates the exact canonical type, slug, title, and sections
  through the Phase 1 transaction.
- Pending state survives reload while active content remains unchanged.
- The UI says **Submitted for independent review**, never **Saved**, for a shared
  proposal.

### Acceptance evidence

Promotion workflow `30530501216` passed:

- API and web typechecks;
- Phase 3 API matrix — **5 suites / 31 tests**;
- web result contract — **1 file / 2 tests**;
- moving-main reconfirmation;
- Program Element forbidden-path assertion.

Required PR workflows on `a3f40638` all passed:

- `ci-pr` `30530842082`;
- `meriv2-evals` `30530842133`;
- `engagement-trust-boundary` `30530842075`;
- `funding-opportunities-ci` `30530842064`;
- `legiwatch-ci` `30530842063`.

### Acceptance

**PASS.** No Settings path can directly replace active firm/client steering context;
shared edits remain pending until independent review, walls fail closed, personal files
remain private and immediate, and reload displays truthful pending state.

---

## Phase 4 — immutable reviewed corrections and restores

### Implementation

- Initial immutable-version implementation:
  `700dc2fc62aced7ec126a57d014f428318aa2d6c`
- Re-audited code-bearing SHA:
  `04b9b1050d64bec3cbe47b24973e6cff70cfd2fe`
- Accepted code/scaffolding-cleanup SHA:
  `30cad17a9ca382af26e90cbcc0f88d7401685d06`

### Runtime contract

- Personal correction creates a new private active row and supersedes exactly one prior
  row transactionally.
- Firm/client correction creates a review candidate and leaves controlling truth
  unchanged until independent approval.
- Restore creates a new version referencing history and never reopens a terminal row.
- Exact duplicate content confirms and links the controlling row without creating a
  second truth.
- Contradictions retain both versions in one conflict group while noncontrolling claims
  remain withheld.
- Approval is row-locked, independently authorized, target-bound, and atomic with
  versioning, lineage, audit, and cleanup intent.
- Legal holds block terminal transitions and are inherited by derivative versions.
- The generic approval path is database-blocked for correction, restore, and
  contradiction candidates.
- Expired restores and long-slug identity boundaries are guarded.

### Acceptance evidence

- `memory-governance-ci` `30546024134` — API dependency typecheck plus
  **5 suites / 31 tests PASS**;
- `ci-pr` `30546024138` — **PASS**;
- `meriv2-evals` `30546024142` — **PASS**;
- `engagement-trust-boundary` `30546024217` — **PASS**;
- `funding-opportunities-ci` `30546024216` — **PASS**;
- `legiwatch-ci` `30546024224` — **PASS**.

### Acceptance

**PASS.** Corrections and restores preserve immutable history, cannot alter shared
controlling truth without independent review, and preserve duplicate, contradiction,
legal-hold, expiry, and target-lineage invariants.

---

## Phase 5 — scheduled failure-aware projection/index worker

### Implementation

- Phase 5 code-bearing acceptance SHA:
  `0f5ded51aaa74a74e09fc26256469eee263ee4ea`
- Cumulative-gate implementation and validation SHA:
  `8fdcd83aeac66f37e61c57a962ce969f1d6de2ac`

### Runtime contract

- `index_memory_item` is a durable obligation committed with the memory write.
- The scheduled worker claims bounded batches using `FOR UPDATE SKIP LOCKED` and opaque
  expiring leases.
- Projection and embedding run outside the claim transaction.
- Strict projection awaits canonical upsert and embedding and verifies both before
  completion.
- Source edits/deletes during embedding cannot mark stale content complete.
- Completion/failure requires the current lease owner.
- Retries use bounded exponential backoff; exhausted work enters `dead_letter`.
- Logs and persisted failure state use bounded codes without memory bodies or provider
  responses.
- The separate CDK stack supplies a five-minute EventBridge schedule, app DB credential,
  Titan-v2-only IAM, one-year logs, metrics, and alarms.

### Acceptance evidence

The first Phase 5 exact-head gate passed API/CDK typechecks and **10 suites / 61 tests**.

The cumulative Phase 1–5 gate on `8fdcd83a` passed:

- full repository typecheck;
- Phase 5 CDK typecheck;
- API governed-memory matrix — **50 suites / 445 tests**;
- orchestrator Context/Strategy/Steward matrix — **4 suites / 24 tests**;
- Workspace canonical-context matrix — **4 suites / 32 tests**;
- Settings web contract — **1 file / 2 tests**.

Cumulative total: **59 files/suites and 503 tests, all passing**.

Required workflows on `8fdcd83a`:

- `memory-governance-ci` `30556617455` — **PASS**;
- `ci-pr` `30556617301` — **PASS**;
- `meriv2-evals` `30556617261` — **PASS**;
- `engagement-trust-boundary` `30556617425` — **PASS**;
- `legiwatch-ci` `30556617325` — **PASS**;
- `funding-opportunities-ci` `30556617342` — **PASS**.

### Acceptance

**PASS.** Failed fast-path work cannot disappear, concurrent workers cannot own one
live lease, stale claims recover, exhausted jobs become observable, and completion
requires durable canonical and embedding state.

---

## Cumulative Phases 1–5 closure

### Cumulative gate

The permanent `memory-governance-ci` workflow is now a superset of the individual phase
acceptance matrices. It runs on one exact head and covers:

- all API memory specs plus Context v2 and Workspace-assistant adapters;
- immutable version and migration guards;
- the Phase 5 producer/worker/lease/infrastructure contracts;
- orchestrator Context v2, Strategy, and Steward tests;
- Workspace canonical-memory and assurance tests;
- the Settings shared-review web result contract;
- full repository and CDK typechecks.

### Closure result

**PHASES 1–5 CUMULATIVE ACCEPTANCE: PASS.**

Later Phase 4 and Phase 5 changes did not invalidate atomic activation, canonical
governance propagation, Settings review behavior, immutable versioning, or durable
projection/index semantics. The cumulative validation matrix passed all 503 tests and
all six required workflows.

### Deferred boundaries

These are intentional later-phase or release-certification items and do not reopen
Phases 1–5:

- Phase 6: route every request-time caller through strict outbox/exact-version
  completion and complete the Context Packet v2 rollout contract;
- later disposable-PostgreSQL production-equivalent rehearsal, upgrade, rollback,
  RLS/FORCE, and concurrency proof;
- authenticated browser acceptance and narrow-width/keyboard verification;
- final SOC 2 control mapping and production rollout runbooks;
- production migration, backfill, deployment, and feature-flag activation.

### Rollback posture

- Keep governed-memory and release flags dark until their rollout phase.
- Preserve additive schema, candidates, immutable history, audit records, and outbox
  obligations.
- Roll application/task definitions back rather than running destructive down
  migrations.
- Disable the Phase 5 EventBridge rule to pause out-of-band projection work.
- Never reopen terminal rows, activate pending shared proposals during rollback, or
  delete historical versions.

**Next gated phase: Phase 6.**
