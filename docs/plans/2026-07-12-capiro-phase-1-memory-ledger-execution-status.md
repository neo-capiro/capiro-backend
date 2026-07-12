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

## RLS proof — PASSED 2026-07-12 (⚠️ ran against PROD, not the clone)

The intent was an Aurora copy-on-write clone (same playbook as the 2026-07-05
`clio_memory` RLS rollout). A clone WAS created, but the `prisma db execute`
migration + verify runs used a `DB_HOST` env override on the
`capiro-dev-api-sql-exec` task def — and `DB_HOST` there is a task-def
**secret**, which beats a `containerOverrides` env of the same name. So the
override was ignored and everything ran against **prod**. The clone was never
written to and was torn down. See
`memory/infra_sqlexec_dbhost_secret_beats_override.md` for the trap.

Net effect on prod (all verified): the 3 migrations' DDL applied correctly,
and the RLS proof passed on real data — as `capiro_app`, under `SET ROLE`
with a no-GUC control proving RLS was engaged:

- 1A: all **5,253** real memory rows got non-null `status='active'` +
  `exportable`/`excluded`/not-held defaults — no null-constraint failures.
- 1C: non-owner **blocked** from a private row (0), owner sees it (1),
  tenant-shared visible (1), wrong-tenant sees nothing (0), no-GUC fail-closed (0).
- context_embeddings backfill: 1,230 private-item embeddings got
  `owner_user_id`, column count == join count exactly.
- Synthetic test rows were cleaned up (verified 0 remaining).

Consequence + recovery: because the DDL landed via `prisma db execute` (which
does not touch `_prisma_migrations`), the later `deploy-dev.sh migrate deploy`
hit P3018 `column "status" already exists`. Recovered by deleting the failed 1A
row and `prisma migrate resolve --applied` for all three (records them with
correct checksums, runs no SQL) → migrate became a clean no-op. The 1C
owner-aware policy was live on prod while the OLD api code (no
`app.current_user`) still served, so private memories were briefly invisible to
their owners (read-only, self-healing); closed by the api roll onto the
`withTenantUser` code.

## Exit gate (§10) status — post-deploy 2026-07-12

Shipped to prod: PR #432 (merge `409061c`), api task-def rev 41 + orchestrator
rolled, all 4 migrations recorded applied, **0 exceptions / 0 RLS-permission
errors** across the first post-roll window.

- **G1** private scope DB-enforced — **MET** (proven on prod real data: owner
  sees / non-owner blocked / tenant-shared unaffected / no-GUC fail-closed).
- **G3** no memory write bypasses the candidate gate; old admin-reject branch
  deleted — **MET**.
- **G4** `memory_items` carries Table-19 metadata; write paths populate it —
  **MET**.
- **G5** personal-scope `save_memory` inline auto-commit (unchanged latency) —
  **MET** by construction (formal integration-diff still worth a live check).
- **G6** D1 recorded in code + docs — **MET**.
- **G2** verbs demonstrably work in a live chat session (confirm/correct/forget/
  export, observable) — **PENDING**. Needs a real user JWT / chat turn; can't be
  driven headlessly. The verb SQL is unit-tested for control flow but has NOT
  been exercised against a real DB (the "rehearsal" predated the verbs) — the
  G2 live smoke is its first real-DB run; watch `correct`/`forget` closely.
- **G7** 1C RLS canary green for one full traffic cycle — **IN PROGRESS**
  (0 errors so far; needs the observation window to elapse).

## Honest remaining before Phase 1 is fully "done"

1. **G2 live smoke** (needs a capiro-internal user session, so likely Ninja or a
   test login): save a memory → `search_memory` (returns `memoryItemId`) →
   `confirm_memory` / `correct_memory` / `forget_memory` / export, each observed;
   confirm a private item is visible to its owner again (degradation closed) and
   invisible cross-user in the running app.
2. **G7**: let the RLS canary window elapse with continued 0 errors.
3. The DB_HOST-override incident (rehearsal ran against prod) is written up in
   `memory/infra_sqlexec_dbhost_secret_beats_override.md` so it isn't repeated.
