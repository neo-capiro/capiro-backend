# MeriV2 Phases 1–5 — Cumulative Acceptance Certificate

## Decision

**PASS.** Phases 1–5 are cumulatively complete at the code-level boundary defined by
the closeout plan and are closed before Phase 6 implementation begins.

Repository: `neo-capiro/capirov2`  
Branch: `agent/meriv2-world-class-closeout`  
Draft PR: `#679`  
Cumulative validation SHA: `8fdcd83aeac66f37e61c57a962ce969f1d6de2ac`

## Accepted phase contracts

### Phase 1 — atomic candidate activation

Candidate decision, canonical mutation, lineage, transition evidence, and durable
projection obligation share one tenant-scoped transaction. Concurrent decisions
serialize, terminal candidates cannot be reapproved, cross-tenant IDs do not disclose
existence, and shared proposals require independent review.

### Phase 2 — canonical governed activation

Approved governance is authoritative on the active `memory_items` version. Candidate
lineage and authority remain consistent through the Clio compatibility projection,
Context Packet v2, API, orchestrator, Strategy, Steward, and Workspace. Pending memory
is withheld.

### Phase 3 — Settings shared-memory review

Firm/client Settings edits create complete review candidates and leave active steering
content unchanged. Personal files remain immediate and owner-only. Client walls fail
closed and the UI reports pending independent review truthfully.

### Phase 4 — immutable corrections and restores

Corrections and restores create immutable versions; terminal rows never reactivate.
Shared controlling truth changes only through independent, row-locked, target-bound
approval. Exact duplicates do not create a second truth, contradictions retain both
versions, and legal-hold/expiry/lineage guards are enforced.

### Phase 5 — durable projection and indexing

Failed immediate projection leaves a durable outbox obligation. A scheduled strict
worker claims work with expiring leases, verifies canonical and embedding state before
completion, retries with bounded backoff, recovers stale claims, and dead-letters
exhausted work. Infrastructure uses a dedicated scheduled task, app DB credentials,
Titan-only embedding IAM, retained logs, metrics, and alarms.

## Cumulative matrix

The permanent `memory-governance-ci` workflow was expanded to run a superset of the
individual acceptance suites on one exact head.

- Full repository typecheck — **PASS**.
- Phase 5 CDK typecheck — **PASS**.
- API governed-memory matrix — **50 suites / 445 tests PASS**.
- MeriV2 orchestrator Context/Strategy/Steward matrix — **4 suites / 24 tests PASS**.
- Workspace canonical-context matrix — **4 suites / 32 tests PASS**.
- Settings web result contract — **1 file / 2 tests PASS**.

**Total: 59 files/suites and 503 tests, all passing.**

## Required workflow evidence

All six required workflows passed on
`8fdcd83aeac66f37e61c57a962ce969f1d6de2ac`:

- `memory-governance-ci` run `30556617455`;
- `ci-pr` run `30556617301`;
- `meriv2-evals` run `30556617261`;
- `engagement-trust-boundary` run `30556617425`;
- `legiwatch-ci` run `30556617325`;
- `funding-opportunities-ci` run `30556617342`.

No unresolved PR review threads existed at the cumulative review boundary.

## Closure boundary

This certificate closes the implementation and code-level acceptance of Phases 1–5.
It is not a production release certificate. The following remain intentionally later
work:

- Phase 6 strict request-time routing and exact-version completion;
- Context Packet v2 rollout-mode and per-tenant gating completion;
- disposable-PostgreSQL production-equivalent migration/rollback/RLS/concurrency
  rehearsal;
- authenticated browser and accessibility acceptance;
- final SOC 2 control mapping and production rollout runbooks;
- production migration, backfill, deployment, and flag activation.

These deferred items do not reopen Phases 1–5.

## Safety and rollback

- Keep release and governance flags dark until their rollout phase.
- Preserve additive schema, candidate history, immutable versions, audit evidence, and
  outbox rows.
- Roll back application/task definitions rather than executing destructive down
  migrations.
- Disable the Phase 5 EventBridge rule to pause scheduled projection processing.
- Never reopen terminal history or activate pending shared proposals during rollback.

No merge to `main`, production deployment, production migration application, backfill,
feature-flag activation, AWS operation, external send, or customer-data mutation was
performed to produce this certificate.

**Next gated phase: Phase 6.**
