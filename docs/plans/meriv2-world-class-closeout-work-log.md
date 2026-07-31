# MeriV2 World-Class Closeout — Work Log

**Repository:** `neo-capiro/capirov2`  
**Primary branch:** `agent/meriv2-world-class-closeout`  
**Primary PR:** `#679`  
**State:** Draft, unmerged  
**Authoritative through:** Phase 8 code acceptance  
**Phase 8 runtime/test head:** `b18d520c02ead55cc629a72a2832149d76520baf`  
**Phase 8 first green CI evidence head:** `0ed128de929e5982578bd7d6725310044d9d79b9`  
**Moving baseline at the Phase 8 acceptance check:** `main@3dcb12f823774b6fae8578dc56fc122bf9a0879e`

No merge to `main`, AWS deployment, shared/production migration, production backfill, feature-flag activation, customer-data mutation, external send, or production rollout occurred during Phases 0–8.

---

## Operating ledger

The closeout branch is published history. Synchronization uses ordinary merge commits; no force-push or rebase is permitted. Before every phase, promotion commit, and acceptance gate, current `main` is re-read and current-main behavior wins every overlap. Program Element and defense-budget work remains outside the MeriV2 closeout boundary unless an exact MeriV2 control requires a narrow additive overlap.

Release-blocking invariants:

- browser-supplied tenant, role, ethical-wall, approval, policy, context-health, and assurance claims are never trusted;
- firm/client institutional memory is immutable and independently reviewed;
- correctness and auditability work is transactional or durably queued;
- terminal memory rows are never reopened;
- logs and metrics contain bounded IDs, statuses, hashes, reason codes, counts, and timestamps only;
- no phase advances until its acceptance gate passes on a synchronized head;
- PR #679 remains draft and unmerged until the later release gates and separately authorized production rollout.

---

## Phase 0 — branch synchronization and executable baseline

**PASS.** The branch was synchronized with moving `main` without rewriting public history. Current-main District Nexus, Program Element, and production behavior were retained.

- synchronization merge: `21786e16f7235f31108fee770b9b403316df7e33`;
- PR #679 remained draft, mergeable, and unmerged;
- no production action occurred.

---

## Phase 1 — atomic candidate activation

**PASS.** Candidate approval, canonical memory mutation, candidate decision, exact lineage, transition evidence, and the durable projection obligation commit or roll back in one server-owned tenant transaction. Concurrent approval serializes; only one caller can decide a pending candidate. Personal activation and rejection use the same atomic boundary.

- implementation: `dd4ce36e47b0566a53c5f98695c630a1920962aa`;
- targeted validation: **6 suites / 43 tests PASS**;
- all required workflows PASS.

---

## Phase 2 — canonical governed-memory activation

**PASS.** Approved candidate governance is authoritative on the active `memory_items` version and remains consistent through Clio compatibility projection, API reads, Context Packet v2, Strategy, Steward, and Workspace. Pending memory is withheld and candidate/item lineage is exact.

- implementation: `36b0a991f6b5f67efe2db41a29e039d1897285cd`;
- API matrix: **10 suites / 88 tests PASS**;
- orchestrator/Strategy/Steward: **4 suites / 24 tests PASS**;
- Workspace: **2 suites / 13 tests PASS**;
- all required workflows PASS.

---

## Phase 3 — Settings shared-memory review lifecycle

**PASS.** Firm/client Settings edits create complete-state review candidates and leave active steering context unchanged until independent approval. First-time shared files create candidates only. Personal files remain immediate and owner-only. Reload presents truthful pending state.

- runtime implementation: `51bcb642851bbfcdc452908c94a830afd6a07733`;
- API matrix: **5 suites / 31 tests PASS**;
- web contract: **1 file / 2 tests PASS**;
- Program Element forbidden-path assertion PASS;
- all required workflows PASS.

---

## Phase 4 — immutable corrections, restores, duplicates, and conflicts

**PASS.** Corrections and restores create immutable new versions and never reopen revoked or superseded rows. Shared changes remain independently reviewed. Exact duplicates link existing truth. Contradictions retain both versions in an explicit conflict group. Legal hold, expiry, target lineage, tenant isolation, and ethical walls fail closed.

- accepted cumulative validation head: `860bc2acde8a90f4a8e43e573a09a9135d114681`;
- API: **45 suites / 409 tests PASS**;
- orchestrator: **4 suites / 24 tests PASS**;
- Workspace: **4 suites / 32 tests PASS**;
- Settings: **1 file / 2 tests PASS**;
- cumulative: **54 suites/files / 467 tests PASS**;
- all required workflows PASS.

Detailed acceptance: `docs/qa/meriv2-phase-4-immutable-memory-versions.md`.

---

## Phase 5 — scheduled failure-aware projection/index worker

**PASS.** Durable projection jobs are claimed in bounded batches with `FOR UPDATE SKIP LOCKED`, opaque expiring leases, stale-lease recovery, bounded exponential backoff, and terminal dead-letter state. Projection and embedding execute outside the claim transaction. Completion requires current lease ownership plus verified canonical and embedding state.

- code-bearing acceptance: `0f5ded51aaa74a74e09fc26256469eee263ee4ea`;
- cumulative validation: `8fdcd83aeac66f37e61c57a962ce969f1d6de2ac`;
- API: **50 suites / 445 tests PASS**;
- orchestrator: **4 suites / 24 tests PASS**;
- Workspace: **4 suites / 32 tests PASS**;
- Settings: **1 file / 2 tests PASS**;
- cumulative: **59 suites/files / 503 tests PASS**;
- worker infrastructure/CDK typecheck PASS;
- all required workflows PASS.

Detailed acceptance: `docs/qa/meriv2-phase-5-memory-projection-worker.md`.

---

## Phase 6 — exact request-time projection completion

**PASS.** Every covered request-time caller durably owes exact-version projection work before returning. Completion is bound to the expected source version, content hash, tenant, operation, idempotency identity, exact job, and current lease. A changed source supersedes stale work; a vanished source completes idempotently; partial or unembedded state cannot report completion.

- accepted runtime head: `67288bb76ed0a02a7cc4e56f191b27847483dd3a`;
- API: **54 suites / 472 tests PASS**;
- orchestrator: **4 suites / 24 tests PASS**;
- Workspace: **4 suites / 32 tests PASS**;
- Settings: **1 file / 2 tests PASS**;
- cumulative: **63 suites/files / 530 tests PASS**;
- all required workflows PASS;
- branch 0 commits behind `main@3dcb12f823774b6fae8578dc56fc122bf9a0879e` at acceptance.

Detailed acceptance: `docs/qa/meriv2-phase-6-exact-projection-completion.md`.

---

## Phase 7 — truthful Context Packet persistence

**PASS.** A packet ID becomes public only after awaited exact-row persistence and tenant-scoped read-after-write verification. Best-effort failure returns no ID and bounded degraded evidence. Required audited generation boundaries hold before release. Workspace persistence holds are request-local, Context Inspector requires explicit persistence proof, and persisted traces retain the server-resolved effective tenant identity.

- accepted validation head: `f8d886d4d24c6b8778c21a94e72d3bc6036267d0`;
- accepted runtime-fix head: `a3535542318004dd5454d6efc07216844cd38936`;
- API: **55 suites / 480 tests PASS**;
- Phase 7 core: **2 suites / 16 tests PASS**;
- orchestrator/Strategy/Steward: **6 suites / 37 tests PASS**;
- Workspace: **5 suites / 37 tests PASS**;
- Settings and Context Inspector: **2 files / 10 tests PASS**;
- cumulative: **70 suites/files / 580 tests PASS**;
- all required workflows PASS;
- branch 0 commits behind `main@3dcb12f823774b6fae8578dc56fc122bf9a0879e` at acceptance.

Detailed acceptance: `docs/qa/meriv2-phase-7-truthful-context-persistence.md`.

---

## Phase 8 — Context Packet v2 rollout and complete surface policy

### Runtime contract

- `MERIV2_CONTEXT_PACKET_V2` accepts `off`, `shadow`, or `enforce`; missing and invalid values fail closed to `off`;
- the environment value is the global ceiling; tenant settings select narrower per-surface canaries and cannot raise that ceiling;
- tenant-canary lookup failure fails closed to `off`;
- `off` executes one v1 compile and does not read governed v2-only columns;
- `shadow` truthfully compiles/persists v1 and v2 but returns v1 unchanged;
- shadow comparison evidence is bounded to IDs, hashes, counts, reason codes, health, layer gaps, token deltas, and regression booleans—never bodies, titles, prompts, secrets, provider payloads, or email content;
- `enforce` uses one explicit policy for every audited surface;
- required and optional layers are distinct: optional loss does not degrade health, required loss does;
- memo, outreach, district-brief, and research surfaces render plain governed content and do not print the internal typed envelope into deliverables;
- API, orchestrator, and Workspace resolve rollout and ethical-wall state on the server;
- Phase 7 truthful persistence remains mandatory: no durable row means no public packet ID.

Explicit policy covers `chat`, `ga-chat`, `tool-invoke`, `in-editor`, `workspace-editor`, `strategy`, `steward`, `outreach`, `memo`, `district-brief`, `research`, and `workspace-gen`.

### Accepted heads

- Phase 8 runtime/test head: `b18d520c02ead55cc629a72a2832149d76520baf`;
- repository-native CI retrigger/evidence head: `0ed128de929e5982578bd7d6725310044d9d79b9`.

### CI blocker and resolution

The first workflow attempts created jobs with zero executed steps because GitHub Actions usage was blocked at the account level. A failed-jobs API rerun and an evidence-only commit reproduced the runner-admission failure. After the account billing/usage restriction was corrected, the same six failed workflow runs were retriggered through the GitHub API. Real hosted runners started, every step executed, and all checks passed without a runtime, workflow, migration, test-expectation, branch-protection, Program Element, or customer-data change.

### Acceptance evidence

On `0ed128de929e5982578bd7d6725310044d9d79b9`:

- all five Prisma clients generated — **PASS**;
- full repository dependency graph — **18/18 typecheck tasks PASS**;
- projection-worker infrastructure typecheck — **PASS**;
- API governed-memory Phases 1–8 — **59 suites / 500 tests PASS**;
- Phase 8 core release switch, rollout, truthful persistence, and surface policy — **4 suites / 37 tests PASS**;
- orchestrator Context, Strategy, and Steward — **6 suites / 37 tests PASS**;
- Workspace canonical context and request-local persistence hold — **5 suites / 39 tests PASS**;
- Settings and Context Inspector — **2 files / 10 tests PASS**.

**Cumulative total: 76 suites/files / 623 tests PASS.**

Required workflows:

- `memory-governance-ci` run `30594862249` — **PASS**;
- `ci-pr` run `30594862253` — **PASS**;
- `meriv2-evals` run `30594862254` — **PASS**;
- `engagement-trust-boundary` run `30594862243` — **PASS**;
- `legiwatch-ci` run `30594862267` — **PASS**;
- `funding-opportunities-ci` run `30594862263` — **PASS**.

The Engagement and Funding Opportunities workflows also completed clean-PostgreSQL migration, schema, test, and build checks. No migration was applied to a shared or production environment.

Immediately before recording the gate, the branch remained **0 commits behind** `main@3dcb12f823774b6fae8578dc56fc122bf9a0879e`. Phase 8 did not modify Program Element or defense-budget runtime behavior.

### Acceptance

**PASS.** Internal tenants can observe v2 without changing model or product output, bounded comparison evidence detects confidentiality and relevance regressions without retaining confidential content, and enforcement is possible only through explicit server-owned global, tenant, surface, layer, persistence, sensitivity, budget, and rendering policy.

### Rollback posture

- set `MERIV2_CONTEXT_PACKET_V2=off`;
- keep tenant and per-surface canaries disabled;
- preserve v1 as the operational fallback;
- preserve Context Packet rows and additive schema;
- do not restore fire-and-forget persistence, generated public IDs, or browser-owned policy decisions.

Detailed acceptance: `docs/qa/meriv2-phase-8-context-packet-rollout.md`.

---

## Cumulative Phases 1–8 closure

**PHASES 1–8 CUMULATIVE CODE ACCEPTANCE: PASS.**

Phase 8 does not invalidate atomic activation, canonical governance, Settings review, immutable versioning, durable projection, exact completion, or truthful persistence. The permanent cumulative workflow proves the entire Phase 1–8 contract on one synchronized exact code/evidence head.

Still deferred to later phases and release certification:

- governed-status authority, persisted action-policy authority, backfill/grants/withdrawal lifecycle, administration UX, assurance enforcement, migration rehearsal, authenticated browser/accessibility acceptance, SOC 2 control mapping, rollout/rollback operations, and production gates;
- shared/production migration, production backfill, deployment, feature-flag activation, and customer-data operations.

**Next gated phase: Phase 9 — make `governed_status` the authoritative v2 lifecycle state.** Do not merge or deploy PR #679.
