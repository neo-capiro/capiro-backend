# MeriV2 World-Class Closeout — Work Log

Traceability ledger for the closeout of draft PR **#679** on branch
`agent/meriv2-world-class-closeout`.

> No production deployment, migration, backfill, flag change, or external
> communication has been performed by any step recorded in this log.

---

## Phase 0 — baseline, branch safety, evidence capture

### SHAs

| Ref | SHA | Note |
| --- | --- | --- |
| `origin/main` at sync | `7dfed147` | merge base target |
| Branch tip before sync (local) | `83234888` | 4 commits ahead of the pushed branch |
| Pushed branch tip before sync | `07c9e04e` | `origin/agent/meriv2-world-class-closeout` |
| In-flight work committed | `4019c5e2` | see "Recovered work" below |
| **Merge commit (branch now contains current main)** | **`6757d093`** | `git merge --no-ff origin/main` |

Divergence before sync: **6 behind / 10 ahead** of `origin/main`.
Divergence after sync: **0 behind / 12 ahead**.

### Recovered work (pre-existing, uncommitted)

The worktree held **27 dirty paths** (~584 modified lines + ~1,416 untracked
lines) of unfinished Phase 6 work that no commit owned. It was committed
verbatim as `4019c5e2` *before* the merge so the sync could not destroy it:

- `packages/meriv2-core/src/context/context-release-switch.ts` (+ spec) — pure
  `CONTEXT_PACKET_V2` mode parser, armed only for the exact string `enforce`,
  gated by an audited surface allowlist.
- `packages/meriv2-core/src/context/governed-columns.ts` — governed-column
  selection helper.
- v2 request wiring across `apps/api`, `apps/meriv2-orchestrator`,
  `apps/workspace` compilers plus the context-packet view/controller.
- Six new v2 spec files.

Verified before committing: `@capiro/meriv2-core` builds clean, suite is
**38 suites / 441 passed / 2 todo**.

> **Plan divergence to reconcile in Phase 6.** This switch implements two modes
> (`v1`/`v2`) under env `CONTEXT_PACKET_V2`. The plan (§6) specifies **three**
> modes under `MERIV2_CONTEXT_PACKET_V2=off|shadow|enforce`, plus a per-tenant
> `MeriV2FlagsService` flag with the environment as global ceiling. `shadow`
> (compile + persist v2, still feed v1 to the model) and the tenant flag do not
> exist yet.

### Merge conflict resolution (1 file)

`apps/api/scripts/entrypoint-dispatcher.inc` — conflict confined to the
`Unknown command:` usage string. Both sides had added dispatch cases that merged
cleanly in the body; only the help text collided.

Resolved as a **verified union**, not a side preference:

- branch-only tokens preserved: `drain-memory-cleanup-outbox`,
  `backfill-memory-governance`, `diag-memory-governance`
- main-only tokens gained: 9 (SAM opportunities, funding candidates,
  contractor identifiers, lifecycle processing, backfills)
- token counts: branch 128, main 134, **resolved 137**

The resolution was asserted programmatically to be a superset of *both* sides'
token sets, and both sides' `case` arms were confirmed present in the merged
body. `bash -n` passes on `entrypoint.sh` and `entrypoint-legacy.sh`.

### Baseline after sync

All five Prisma clients generate:

| Client | Result |
| --- | --- |
| `@capiro/api` | generated |
| `@capiro/api-strategy` | generated |
| `@capiro/intel-api` | generated |
| `@capiro/onboard-api` | generated |
| `@capiro/workspace` | generated |

Package builds: `shared`, `auth`, `strategy-verifier`, `meriv2-core` — **all OK**.

Typecheck — **6 / 6 PASS**: `meriv2-core`, `api`, `workspace`, `web`,
`meriv2-orchestrator`, `api-strategy`.

Tests:

| Project | Suites | Tests | Status |
| --- | --- | --- | --- |
| `meriv2-core` | 38 passed / 38 | 441 passed, 2 todo | green |
| `meriv2-orchestrator` | 29 passed / 29 | 319 passed, 2 skipped | green |
| `api-strategy` | 58 passed, 4 skipped / 62 | 1,220 passed, 17 skipped | green |
| `workspace` | **3 failed**, 15 passed / 18 | 1 failed, 140 passed | see below |
| `web` | **2 failed**, 168 passed / 170 | — | see below |
| `api` | pending | pending | pending |

Failures observed, pending base-SHA reproduction (plan §14 forbids calling a
failure pre-existing without it):

| Failure | Intersects branch diff? |
| --- | --- |
| `apps/workspace/test/cascade.spec.ts` — canonical product count | No |
| `apps/workspace/test/pe-resolver.spec.ts` — suite failed to run | No |
| `apps/workspace/test/engine-api.int-spec.ts` — suite failed to run | No |
| `apps/web/.../meri-prompt.test.ts` — `vi.mock` hoist error | No |
| `apps/web/.../FundingOpportunitiesPage.test.tsx` | No |

The branch's `apps/workspace` diff touches only `src/checks/*`,
`src/generation/*`, and `test/apply-generated-sections.spec.ts` — none of the
failing files. A dedicated `origin/main` worktree (`/c/dev/capiro-mv2-base-wt`)
was created to reproduce these on the exact base SHA.

### Call-site inventory (pre-implementation)

| Search | Hits | Files |
| --- | --- | --- |
| `proposeSaveMemory\|commitToClioMemory\|memoryCandidate\|memory_candidate` | 153 | 32 |
| `MemoryAuthorizationService\|requireCandidate\|requireItem` | 37 | 10 |
| `contractVersion\|compileV2\|loadGovernedSteeringRows\|ContextCompiler` | 140 | 37 |
| `MERI_RELEASE_GATE\|evaluateAssuranceRelease\|assessGeneratedDocumentForRelease` | 87 | 21 |
| `evaluatePolicyPack\|ruleBasedCompliancePolicy\|PROPOSED_CAPIRO_RULES` | 44 | 13 |
| `memory_cleanup_outbox\|memory_transition_audit\|memory_access_grant` | 102 | 17 |

---

## Gap inventory — §14 sweep run early against the synced branch

Running the final-sweep searches at Phase 0 establishes which acceptance gates
the prior sessions actually closed versus which remain open. **Four
runtime-enforcement gaps remain open**; the framework code around them exists.

| # | Gap | Evidence | Plan ref | Status |
| --- | --- | --- | --- | --- |
| **A** | Shared memory still auto-commits | `memory-candidate-rules.ts:71` `memory.firm.admin_auto_commit`, `:87` `memory.client.admin_auto_commit` | §2.2, checklist item 1 | **OPEN** |
| **B** | Fire-and-forget projection work | `memory-candidate.service.ts:482` `void this.embedMemory(...)`, `:483` `void this.memoryIngest.projectClioMemory(...)`, `meri.service.ts:5083` same | §4, rule 7 | **OPEN** |
| **C** | Ethical wall hardcoded allowed | `packages/meriv2-core/src/context/compiler.ts:188` `ethicalWallAllowed: true` | §6 contract change 3 | **OPEN** |
| **D** | Static ruleset is the live policy source | `apps/meriv2-orchestrator/src/meri/meri-registry.service.ts:67` `ruleBasedCompliancePolicy([...PROPOSED_CAPIRO_RULES])` | §9 | **OPEN** |

Closed by prior commits on this branch (`54e8b6ae`…`83234888`):

- `schema.prisma` drift against both governance migrations (`44709ef2`)
- `context_packet.packet_version` corruption by the governance migration (`5d809bdb`)
- Phase 4 release hold dark by default via `MERI_RELEASE_GATE` (`90f26367`)
- Phase 4 assurance eval gate passing (`fd02f766`)
- governed-memory authority on the live memory edit route (`6d7c8f0c`)
- governance lifecycle backend, dark (`a7fed16b`)
- release gate extended to uncovered surfaces, dark (`0b1dcf85`)
- policy pack / evaluation run persistence + migration `20260811010000_assurance_policy_packs` (`83234888`)

Clean on sweep: hardcoded `degraded: false` / `authority: 'human-authored'`
appear only in spec fixtures (`meri-context-packet-view.spec.ts`), which is
legitimate test data, not production hardcoding. Two comment-only "deliberate
follow-up" notes remain in `chat-assistant.service.ts:133` and
`chat-prompt.ts:136` and need an in-scope/out-of-scope ruling before closeout.

### Traceability table

| Finding | Runtime path | Implementation commit | Unit/integration test | Browser/migration evidence | Status |
| --- | --- | --- | --- | --- | --- |
| Phase 0 branch sync | n/a | `6757d093` | baseline recorded above | n/a | **done** |
| Phase 0 work recovery | n/a | `4019c5e2` | meriv2-core 441 passed | n/a | **done** |
| A — shared auto-commit | `apps/api/src/memory/memory-candidate-rules.ts` | `b1cf7dd6` | `memory-candidate-rules.spec.ts` (brute-forces every shared-scope input; asserts both rule ids unreachable) | none yet | **done (code+test)** |
| B1 — embedding isolation | `apps/api/src/memory/memory-candidate.service.ts`, `apps/api/src/meri/meri.service.ts` | `b1cf7dd6` | `memory-embed-isolation.spec.ts` — **verified to fail 4/5 against the old predicate** | none yet | **done (code+test)** |
| B2 — durable projections | `memory-candidate.service.ts:483-484` | — | — | — | **OPEN** |
| C — server-derived wall | `compiler.ts`, `governance.ts`, `context-release-switch.ts` + all 4 adapters | `c100829d` | `compiler-v2.spec.ts`, `context-release-switch.spec.ts`, workspace walled-run test | none yet | **done (code+test)** |
| D — policy pack selection | `apps/meriv2-orchestrator/src/meri/meri-registry.service.ts` | — | — | — | **OPEN** |

---

## Status against the plan's phases

**Branch:** `agent/meriv2-world-class-closeout` @ `c100829d` (pushed).
**PR #679** remains a DRAFT. No production deploy, migration, backfill, flag
change, or external communication has occurred.

| Phase | State |
| --- | --- |
| 0 — baseline, sync, ledger | **complete** |
| 1 — Prisma/migration single source of truth | partial (drift closed earlier by `44709ef2`; shadow-DB diff proof **not run**) |
| 2 — governed lifecycle | **§2.2 auto-commit closed**; atomic-transaction contract, versioned correction, duplicate/conflict activation still open |
| 3 — authorization on every memory op | partial (existing `MemoryAuthorizationService` work predates this session; full operation matrix not verified) |
| 4 — durable projection cleanup | **embedding isolation closed**; outbox producer for `index_memory_item` and removal of the two fire-and-forget dispatches **open** |
| 5 — reversible backfill | **not started** (no rollback script) |
| 6 — Context Packet v2 on live paths | **wall closed on all 4 surfaces**; `off\|shadow\|enforce` tri-state + per-tenant flag **not implemented** (current switch is two-state `CONTEXT_PACKET_V2`) |
| 7 — truthful persistence + inspector | not started this session |
| 8 — one assurance envelope | prior commits only; not verified this session |
| 9 — policy packs as the real engine | persistence exists (`20260811010000`); runtime selection **open** |
| 10 — trust/memory UX | not started |
| 11 — disposable-Postgres rehearsal | **not started** — needs a live throwaway PG with pgvector |
| 12 — authenticated browser acceptance | **not started** |
| 13 — SOC 2 mapping + runbooks | **not started** (rollback runbook is referenced by a code comment and must exist before merge) |
| 14 — final integration + PR closeout | not started |

### Definition-of-done checklist — actual state

Source: `meriv2-world-class-closeout-executable-plan.md` lines 1526–1591
(58,163 bytes, 1,607 lines, sha256 `d23f7a7d4ec71dcbbfc975bef8a1984f4b5efee6298301c902de9554d39f8fa5`).
Ticked ONLY where there is code plus a test in this repository.

**Governed memory**

- [x] Firm/client admin saves no longer auto-commit — `b1cf7dd6`
- [x] Shared edits create candidates — pre-existing + `b1cf7dd6`
- [x] Proposer and approver are distinct — `requireIndependentReviewer` + `memory-candidate.approval.spec.ts`
- [ ] Candidate approval uses canonical authorization — not verified this session
- [ ] Ethical walls apply to list and direct-by-ID operations — list filtering exists; direct-by-ID matrix unverified
- [ ] Client grants work — `memory-access-grant.service.ts` exists; matrix unverified
- [ ] Archived-client and legal-hold restrictions work — unverified
- [ ] Impersonation records actor and effective identity — unverified
- [ ] Activation is one atomic transaction — **open**, `commitToClioMemory` still spans several `withTenant` calls
- [ ] Corrections are immutable versions — unverified
- [ ] Duplicate/conflict resolution is live — `memory-conflict.service.ts` exists; liveness unverified
- [ ] Transition audit written on every lifecycle change — partial (`markDecided` under `MEMORY_GOVERNANCE_LIFECYCLE`)
- [ ] Projection/index work is durable — **open, see blocker below**
- [x] Embedding updates target exact IDs — `b1cf7dd6`, regression-proven

**Database and operations** — all 8 unticked. Prisma drift was closed by
`44709ef2` but the shadow-database diff proof (§1.6) has not been run, and §11
needs a disposable PostgreSQL with pgvector.

**Context Packet v2**

- [ ] Live callers pass v2 contract in enforce mode — wired, but dark; no enforce run
- [ ] All adapters load governed fields — `governed-columns.ts` exists; unverified per adapter
- [x] Ethical-wall decision is server-derived and fail-closed — `c100829d`
- [ ] Approval/source/sensitivity/conflict/validity affect recall — filter exists; end-to-end unverified
- [ ] Required/optional layer health correct — unverified
- [ ] Persistence cannot lie — §7 not started
- [ ] Inspector shows actual metadata — §7 not started
- [ ] Inspector IDs unique — §7 not started

**Assurance and policy** — 9 unticked. Policy-pack persistence exists
(`20260811010000_assurance_policy_packs`) but `meri-registry.service.ts:67`
still evaluates the static `PROPOSED_CAPIRO_RULES`, so "real proposals use
selected policy packs" is false.

**Quality and readiness**

- [ ] Authenticated browser matrix — §12 not started
- [ ] Narrow-width / keyboard UX — §12 not started
- [ ] SOC 2 control mapping — §13 not started
- [ ] Metrics/alarms defined — §13 not started
- [ ] Rollout and rollback runbooks executable — **rollback half written**
      (`docs/runbooks/meriv2-memory-context-assurance-rollback.md`, which also
      resolves the previously dangling citation in `memory-candidate-rules.ts`).
      The §13 *rollout* runbook and the control mapping are still missing, so
      this box stays unticked. The rollback doc records honestly that
      `rollback-memory-governance-v2.ts` does not exist yet, which makes a
      production backfill effectively one-way today — a reason not to run one.
- [x] Branch synchronized with `main` — `6757d093`
- [ ] All builds/tests/typechecks/evals/formatting/CI pass — typecheck 6/6 and
      the touched suites pass, but `pnpm turbo run typecheck`, the full
      `eval:meriv2`, and format/lint gates have not been run over the whole repo
- [ ] PR body accurate — PR #679 still says "step 2 incomplete"
- [x] No production action performed

**Tally: 8 of 40 boxes true.**

### Blocker recorded — B2 durable projection (§4)

Not a design preference; a concrete schema/API conflict, documented per
stop-condition 3 rather than guessed at.

`memory-candidate.service.ts:483-484` still dispatches
`void this.embedMemory(...)` and `void this.memoryIngest.projectClioMemory(...)`.
Routing these through the existing outbox does not compose today:

1. `memory_cleanup_outbox.memory_item_id` is **NOT NULL**
   (`20260729010000_memory_governance_context_v2`), but at commit time the caller
   holds a `clio_memory.id` — the `memory_items` row does not exist yet, because
   `projectClioMemory` is what creates it. There is no valid subject id to
   enqueue against, so the producer needs either a nullable subject column or a
   separate `clio_memory_id`-keyed job type (additive migration).
2. `index_memory_item` is deliberately excluded from
   `DRAINABLE_CLEANUP_OPERATIONS` (`memory-cleanup-outbox.service.ts:16-22`,
   and the explicit branch at `:176-182` fails such a job as
   `unsupported operation`). The service is a *deletion* worker and carries no
   embedding provider by design.
3. `commitToClioMemory` spans several separate `withTenant` calls
   (`findExisting` / `updateExisting` / `create`), so there is no single
   transaction to enqueue on. It must be collapsed into one first — which is the
   same restructure the unticked "activation is one atomic transaction" box
   needs, so the two should be done together, not separately.

Recommended order for the next session: collapse `commitToClioMemory` into one
transaction → additive migration for a nullable/alternate outbox subject →
teach the worker `index_memory_item` with an injected embedding provider →
deployment wiring (§4 "Deployment wiring") → then tick both boxes at once.

### Verification recorded this session

- typecheck **6/6 PASS** (`meriv2-core`, `api`, `workspace`, `web`,
  `meriv2-orchestrator`, `api-strategy`)
- `meriv2-core` **445 passed / 2 todo**, 38 suites
- `meriv2-orchestrator` **319 passed**, 29 suites
- `api-strategy` **1,220 passed**, 58 suites
- `workspace` **141 passed**, 15 suites (3 pre-existing failures, reproduced on
  base `7dfed147`)
- `web` 168 suites passing (2 pre-existing failures, reproduced on base)
- `api` 6,036 tests / 505 suites: 37 failed in 13 suites, **all reproduced on
  base**; the only meri-adjacent one (`meri-tools.firmdata.spec.ts`, 17 failed)
  fails identically at `origin/main`
- api memory + context + workspace-assistant after the changes: **42 suites /
  399 tests, all passing**

## Phase 1 — atomic candidate activation (2026-07-30)

### Current baseline and implementation

- Current `main` at the acceptance check: `057f5480a46f9ba9acf9296a9cc876b609593832`.
- Closeout branch was synchronized with that SHA before implementation and was **0 commits behind** at the final comparison.
- Phase 1 implementation commit: `dd4ce36e47b0566a53c5f98695c630a1920962aa`.
- PR #679 remains a draft and unmerged.

### Canonical transaction boundary

Candidate approval now executes one server-owned, tenant-scoped transaction that:

1. locks the candidate row with `FOR UPDATE`;
2. verifies that it is still pending;
3. derives and authorizes the real actor/effective context;
4. enforces independent review for shared memory;
5. creates or updates the canonical Clio memory record;
6. records the committed memory ID on the candidate;
7. writes the candidate terminal decision;
8. writes the transition audit record when lifecycle auditing is enabled;
9. enqueues the durable `index_memory_item` projection obligation; and
10. commits or rolls every mutation back together.

The controller no longer performs a separate authorization preflight before the
service transaction. Personal immediate activation uses the same transaction
boundary. Rejection also locks and decides inside one transaction. Compatibility
helpers delegate to transaction-scoped helpers rather than opening an independent
nested tenant transaction during activation.

### Regression and safety evidence

Exact commands ran on the synchronized source SHA with all five Prisma clients
generated and the internal packages (`shared`, `auth`, `strategy-verifier`, and
`meriv2-core`) built first:

- `pnpm --filter @capiro/api typecheck` — **PASS**.
- Six targeted suites — **6/6 PASS, 43/43 tests**:
  - `memory-candidate.atomicity.spec.ts`;
  - `memory-candidate.approval.spec.ts`;
  - `memory-candidate.governance.spec.ts`;
  - `memory-index-outbox.spec.ts`;
  - `memory-embed-isolation.spec.ts`;
  - `memory.controller.governance.spec.ts`.

The coverage proves:

- two simultaneous approvals produce one activation;
- an injected failure after mutation rolls candidate, memory, audit, and outbox
  state back together;
- a terminal candidate cannot be re-approved;
- a cross-tenant candidate ID returns the same not-found result as a nonexistent
  ID and does not reveal existence;
- personal immediate activation is one transaction;
- a shared candidate cannot be self-approved;
- server context, not browser-supplied tenant/actor values, reaches the canonical
  authorization path.

Validation workflow run `30505202671` and promotion workflow run `30505389837`
both passed the same typecheck and targeted test matrix before the implementation
commit was pushed.

### Acceptance gate

**PASS.** No successful path can leave an activated canonical memory while its
candidate remains pending, and no approved candidate can commit without its
canonical memory mutation, transition evidence, and required outbox obligation
being in the same database transaction. Concurrent callers serialize on the
candidate row and exactly one may decide a pending candidate.

### Rollback

Revert implementation commit `dd4ce36e` if the live code must be withdrawn. Keep
all additive schema and existing audit/outbox rows intact, leave governed-memory
and high-risk release flags dark, and do not force-push the published branch.
No migration, backfill, flag change, AWS deployment, or customer-data operation
was performed during Phase 1.

### Traceability update

| Finding | Runtime path | Implementation | Test evidence | State |
| --- | --- | --- | --- | --- |
| Atomic candidate activation | `apps/api/src/memory/memory-candidate.service.ts` and `memory.controller.ts` | `dd4ce36e` | 6 suites / 43 tests; API typecheck | **complete** |
| Concurrent approval idempotency | candidate row lock + terminal-state check | `dd4ce36e` | `memory-candidate.atomicity.spec.ts` | **complete** |
| Full rollback after partial mutation | one transaction-scoped mutation path | `dd4ce36e` | injected post-mutation failure | **complete** |
| Cross-tenant non-disclosure | tenant transaction + canonical authorization | `dd4ce36e` | same not-found behavior | **complete** |
| Shared self-review denial | independent-review authorization | `dd4ce36e` | approval/governance suites | **complete** |

**Next gated phase:** Phase 2 — propagate approved governance into the canonical
`memory_items` version. Phase 2 must not begin until the normal PR checks on the
Phase 1 evidence SHA are green.

## Phase 2 — canonical governed memory activation (2026-07-30)

- Implementation commit: `36b0a991f6b5f67efe2db41a29e039d1897285cd`.
- Current `main` at promotion: `057f5480a46f9ba9acf9296a9cc876b609593832`; the closeout branch was zero commits behind before promotion.
- Validation workflow `30518247413`: four package typechecks PASS, including the API Program Element safety verification; API 10 suites / 88 tests PASS; orchestrator/Strategy/Steward 4 suites / 24 tests PASS; Workspace 2 suites / 13 tests PASS.
- Candidate approval creates or updates the authoritative governed `memory_items` version inside the Phase 1 transaction and records exact `committed_memory_item_id` lineage.
- Firm/client/personal approvals map to canonical `playbook`, `client-compass`, and `user-profile` steering identities with `firm_approved`, `client_approved`, or `user_asserted` authority.
- A human-reviewed model extraction maps to `analyst_verified`; an unreviewed defensive machine activation remains `model_inferred` and cannot mint approved authority.
- Candidate lineage is stable through `source_version = candidate:<id>` and is carried into the Clio compatibility envelope. Projection retry restores governed metadata only for validated active candidate lineage; generic projection SQL remains pre-migration compatible while governance is dark.
- Approved canonical memory is returned by Context Packet v2 with the same item ID and authority; pending memory is withheld. API, orchestrator, Strategy, Steward, and Workspace consumers passed the consistency matrix.
- Full transaction rollback covers the candidate, canonical item, Clio row, transition evidence, and outbox obligation.
- Acceptance state: isolated implementation gate PASS; normal PR checks pending on the promoted SHA.
- Next gated phase after normal PR CI: Phase 3 — route Settings edits through candidate review.
