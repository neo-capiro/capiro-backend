# Phase 1 — One Memory, One Ledger — Execution Status

Companion to the Phase 1 deployment plan (proposed 2026-07-12). Records the
decisions actually taken and what shipped. Phase 1 makes the blueprint's
§12.5 #1 / §12.8 #9 / Appendix C gate true: private scopes enforced at the
**database** boundary, and users can inspect / confirm / correct / forget /
export memory.

## Decision log (§3) — resolved 2026-07-12

All six adopted the plan's own recommendations (each is a technical call the
plan already reasoned through; none required a business judgment only Ninja
could make). Recorded here so the choices aren't implicit in code.

- **D1 — canonical-ledger framing:** Refine, not reverse. `clio_memory` stays
  Meri's fast KV write/recall path; `memory_items` is canonical for
  *governance* (carries the validity/status/supersession/retention metadata and
  is the row every verb acts on). Write-through direction unchanged.
- **D2 — private-scope mechanism:** Postgres RLS with a third GUC
  (`app.current_user`), mirroring the proven `app.current_tenant` /
  `app.bypass_rls` pattern exactly.
- **D3 — candidate/contradiction depth:** Minimal — key-collision duplicate
  detection (formalized) + surface, no semantic contradiction detection (that
  needs Phase 2 retrieval).
- **D4 — firm governance:** Folded into 1B's candidate/WARN path; the old
  bespoke admin-reject branch deleted, not maintained in parallel.
- **D5 — first surface:** Chat (both legacy + MeriV2 via the delegated write
  tool). Settings `MemoryFileEditor` remains the primary confirm/forget UI
  affordance; chat-bubble UI deferred (not gate-required).
- **D6 — matter scope:** Deferred to Phase 2. Phase 1 enforces user-private
  scope only.

## What shipped (branch `feat/phase1-memory-ledger`)

- **1A** — additive migration `20260712010000_memory_items_governance_fields`:
  `status`, `lastConfirmedAt`, `reviewCadenceDays`, `supersedesId`,
  `contradictsId`, `sensitivity`, `retentionPolicy`, `legalHold`,
  `revokedAt`/`revokedBy`, `exportable`, `trainingUse` (blueprint Table 19).
  Governance helpers now exclude `legalHold` rows from every purge selector;
  `selectForExport` added.
- **1B** — migration `20260712020000_memory_candidate` + `MemoryCandidateService`
  + `evaluateMemoryCandidate`. Every `save_memory` (both surfaces converge on
  `MeriToolsService.saveMemory`) creates a candidate first; personal / admin-firm
  saves auto-commit inline (unchanged latency), a non-admin firm save becomes a
  real pending candidate reviewable at `GET/POST /memory/candidates` — was a
  dead-end rejection before.
- **1C** — migration `20260712030000_memory_items_private_scope_rls`:
  `current_user_id()` GUC fn, `PrismaService.withTenantUser`, owner-aware
  `memory_items` RLS policy, `context_embeddings.owner_user_id` backfilled +
  predicated. All 7 memory-reading call sites converted to `withTenantUser`;
  application-level owner filters kept as defense-in-depth.
- **1D** — `confirm_memory` / `correct_memory` / `forget_memory` verbs +
  `GET /memory/export`. On both chat surfaces. `search_memory` returns
  `memoryItemId` and surfaces only `status='active'` rows.
- **1E** — governance convergence (see D4); grep-verified the old branch is gone.

## Clone rehearsal (the 1C proof) — PASSED 2026-07-12

Aurora copy-on-write clone of live prod (same playbook as the 2026-07-05
`clio_memory` RLS rollout). All three migrations applied cleanly on **5,253**
real memory rows. RLS verified **as `capiro_app`** (master bypasses RLS — tested
under `SET ROLE` with a no-GUC control proving RLS was genuinely engaged):

- 1A: all 5,253 rows got non-null `status='active'` + `exportable`/`excluded`/
  not-held defaults — no null-constraint failures.
- 1C: non-owner **blocked** from a private row (0), owner sees it (1),
  tenant-shared visible to non-owner (1), wrong-tenant sees nothing (0),
  no-GUC fail-closed (0).
- context_embeddings backfill: 1,230 private-item embeddings got
  `owner_user_id`, column count == join count exactly.

Clone + all throwaway plumbing torn down after.

## Exit gate (§10) status

- **G1** private scope DB-enforced (clone-proven, not just asserted) — **MET**.
- **G3** no memory write bypasses the candidate gate; old direct-write / admin-
  reject branch deleted — **MET**.
- **G4** `memory_items` carries Table-19 metadata and the write paths populate
  it — **MET**.
- **G5** personal-scope `save_memory` behavior/latency unchanged (inline
  auto-commit) — **MET** (integration-diff pending in the live smoke).
- **G6** D1 recorded in code + this doc — **MET**.
- **G2** verbs demonstrably work on the chat surface (confirm/correct/forget/
  export, observable in one session) — **PENDING the post-deploy live smoke**
  (the verbs' raw SQL is unit-tested for control flow; end-to-end SQL
  correctness is validated by the G2 live demo, since the clone was torn down
  before the verbs existed).
- **G7** 1C RLS canary green on prod for one full traffic cycle — **PENDING
  deploy**.

## Honest remaining before Phase 1 is "done"

1. Merge the PR (CI green) → deploy: `migrate deploy` (3 additive migrations)
   → roll api + orchestrator → the 1C canary.
2. Live smoke on capiro-internal: save → search (see `memoryItemId`) →
   confirm / correct / forget / export, each observed (G2); a private item
   invisible cross-user in the running app (G1 in prod, not just clone); G7
   canary window.
3. Verb SQL (correct/forget) was control-flow-unit-tested but **not**
   clone-rehearsed (clone predated the verbs) — the G2 live smoke is its first
   real-DB exercise; watch it closely.
