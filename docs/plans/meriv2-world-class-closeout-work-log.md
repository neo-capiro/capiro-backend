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
| Phase 0 branch sync | n/a | `6757d093` | baseline recorded above | n/a | done |
| Phase 0 work recovery | n/a | `4019c5e2` | meriv2-core 441 passed | n/a | done |
| A — shared auto-commit | `apps/api/src/memory/memory-candidate-rules.ts` | — | — | — | open |
| B — durable projections | `apps/api/src/memory/memory-candidate.service.ts`, `apps/api/src/meri/meri.service.ts` | — | — | — | open |
| C — server-derived wall | `packages/meriv2-core/src/context/compiler.ts` | — | — | — | open |
| D — policy pack selection | `apps/meriv2-orchestrator/src/meri/meri-registry.service.ts` | — | — | — | open |
