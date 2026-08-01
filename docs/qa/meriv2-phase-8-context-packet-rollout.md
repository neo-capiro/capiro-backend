# MeriV2 Phase 8 Acceptance — Context Packet v2 Rollout and Surface Policy

**Repository:** `neo-capiro/capirov2`  
**Branch:** `agent/meriv2-world-class-closeout`  
**PR:** `#679`  
**Final Phase 8 runtime/test head:** `b18d520c02ead55cc629a72a2832149d76520baf`  
**CI retrigger/evidence head:** `0ed128de929e5982578bd7d6725310044d9d79b9`  
**Moving baseline at acceptance:** `main@3dcb12f823774b6fae8578dc56fc122bf9a0879e`  
**Branch position at acceptance:** 0 commits behind `main`

## Acceptance result

**PASS.** Context Packet v2 can now be observed and canaried without changing live output, and can be enforced only through explicit global, tenant, and surface policy.

## Runtime contract

- `MERIV2_CONTEXT_PACKET_V2` accepts only `off`, `shadow`, or `enforce`; missing and invalid values resolve to `off`.
- The environment value is the global ceiling. Tenant settings may select a narrower mode per audited surface but cannot exceed that ceiling.
- Tenant-canary lookup failures fail closed to `off`.
- `off` performs one v1 compile and does not read governed v2-only columns.
- `shadow` compiles and truthfully persists v1 and v2, returns the v1 packet unchanged, and stores bounded comparison evidence only.
- Shadow comparison evidence contains IDs, hashes, reason counts, health, layer gaps, token deltas, and regression booleans; it never contains memory bodies, titles, prompts, provider payloads, secrets, or email bodies.
- `enforce` compiles v2 using one explicit policy for each audited surface.
- Required and optional layers are distinct. A missing optional layer does not degrade health; a missing required layer does.
- Client-facing body-rendering surfaces use plain governed content rather than leaking the typed internal XML-like envelope into memos, outreach, district briefs, or research deliverables.
- API, MeriV2 orchestrator, and Workspace adapters resolve tenant mode and ethical-wall access on the server.
- Truthful persistence from Phase 7 remains intact: no durable row means no public packet ID.

## Audited surfaces

Explicit policy exists for:

- `chat`;
- `ga-chat`;
- `tool-invoke`;
- `in-editor` and its persisted alias `workspace-editor`;
- `strategy`;
- `steward`;
- `outreach`;
- `memo`;
- `district-brief`;
- `research`;
- `workspace-gen`.

## Regression and security proof

The Phase 8 core tests prove:

- invalid and missing global modes fail closed;
- tenant settings cannot raise the global ceiling;
- surface overrides are isolated;
- `off` preserves the v1 output path;
- `shadow` returns v1 byte-for-byte while independently persisting v2 evidence;
- a v2 compile or comparison-persistence failure cannot alter the v1 response;
- comparison evidence does not leak confidential content or item identity through denied exclusions;
- optional governed withholding is not mislabeled as a relevance regression;
- required-layer loss is detected as a relevance regression;
- plain-render surfaces strip only the outer internal envelope and preserve content;
- required-versus-optional health semantics are consistent;
- API, orchestrator, Strategy, Steward, Workspace, Settings, and Context Inspector contracts remain green.

## Exact-head validation

On evidence head `0ed128de929e5982578bd7d6725310044d9d79b9`, GitHub Actions initially failed before step execution because account-level Actions usage was blocked. After the account billing/usage restriction was corrected, the failed-job rerun API started real hosted runners and every required workflow completed successfully.

### Permanent cumulative matrix

- all five Prisma clients generated — **PASS**;
- full repository dependency-graph typecheck — **18/18 tasks PASS**;
- projection-worker infrastructure typecheck — **PASS**;
- API governed-memory Phases 1–8 — **59 suites / 500 tests PASS**;
- Phase 8 core persistence, release-switch, rollout, and surface policy — **4 suites / 37 tests PASS**;
- orchestrator Context, Strategy, and Steward — **6 suites / 37 tests PASS**;
- Workspace canonical context and request-local persistence hold — **5 suites / 39 tests PASS**;
- Settings and Context Inspector contracts — **2 files / 10 tests PASS**.

**Cumulative total: 76 suites/files and 623 tests, all passing.**

### Required workflows

- `memory-governance-ci` run `30594862249` — **PASS**;
- `ci-pr` run `30594862253` — **PASS**;
- `meriv2-evals` run `30594862254` — **PASS**;
- `engagement-trust-boundary` run `30594862243` — **PASS**;
- `legiwatch-ci` run `30594862267` — **PASS**;
- `funding-opportunities-ci` run `30594862263` — **PASS**.

The Engagement and Funding Opportunities workflows also completed their clean-PostgreSQL migration, schema, test, and build checks. No migration was applied to a shared or production environment.

## Moving-main and Program Element protection

Immediately before recording this acceptance gate, GitHub reported the branch **0 commits behind** `main@3dcb12f823774b6fae8578dc56fc122bf9a0879e`. Phase 8 did not modify Program Element or defense-budget runtime behavior. Current-main behavior remains authoritative.

## Rollback

- Set `MERIV2_CONTEXT_PACKET_V2=off`.
- Keep tenant and per-surface canaries disabled.
- Do not delete Context Packet rows or roll back additive schema.
- Do not restore fire-and-forget persistence, generated public IDs, or browser-owned policy decisions.
- Preserve v1 as the operational fallback while investigating any v2 comparison signal.

## Production boundary

No merge to `main`, AWS deployment, shared or production migration, production backfill, feature-flag activation, external send, or customer-data operation occurred. PR #679 remains draft and unmerged.

**Next gated phase: Phase 9 — make `governed_status` the authoritative v2 lifecycle state.**
