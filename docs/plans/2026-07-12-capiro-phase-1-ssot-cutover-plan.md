# Phase 1 Completion — Canonical-Store (SSOT) Cutover Plan

**Purpose:** finish the one deferred core of Phase 1 — collapse the two memory stores so `memory_items` is the single source of truth and `clio_memory` stops being an independent recall source. Deferred (per the post-G5 assessment) for **recall-regression risk**. This plan makes that risk *measurable and reversible* so the collapse can ship safely.

**Branch:** `dev/phase1-ssot-consolidation` (off `origin/main` @ #459).
**Status:** measurement gate BUILT + verified this session; the destructive steps (recall re-point + migration) are **gated** — see §5. This document is execution-ready for those steps; they must be clone-rehearsed and run in a scheduled prod window with Ninja's go, per this repo's memory-hardening discipline ([[project_memory_hardening]]).

---

## 1. Why it was deferred — now code-proven

There are **two independent embedding-recall paths** over memory today:

| Path | Reads | Query embed model | Used by |
|---|---|---|---|
| A | `clio_memory.embedding` (own vector column) | **OpenAI** `text-embedding-3-small` (1536-d) | `semanticMemorySearch` → `loadRelevantMemories` — **legacy chat's live auto-inject** (`meri.service.ts:3520`) |
| B | `memory_items` → `context_embeddings` (`source_type='memory_item'`) | **Bedrock Titan** (`embedAndUpsert`) | the `search_memory` tool (`meri-tools.service.ts:1852`) |

Both projections that feed B are **fire-and-forget** (`void this.embedMemory(...)` and `void this.memoryIngest.projectClioMemory(...)`, `memory-candidate.service.ts:284-285`), so each can lag or fail independently.

**The regression:** collapsing means re-pointing path A (the hot, live recall) onto the projection. Any `clio_memory` row whose projection is missing or unembedded would **silently stop being recalled**. That is the exact risk that stopped the collapse — and it was never *quantified*, so nobody could safely decide to flip.

**Second, subtler gotcha (found this session):** paths A and B embed with **different models** (OpenAI vs Titan). Re-pointing A onto `context_embeddings` therefore also requires switching the *query* embedding to Titan and re-tuning the similarity threshold (A currently filters cosine `> 0.3` on OpenAI vectors). "Change the table" is not sufficient.

---

## 2. What shipped this session (safe, non-destructive)

- **`diag-memory-recall-parity`** (`apps/api/scripts/diag-memory-recall-parity.ts`, wired in `entrypoint.sh`) — the **measurement gate**. Read-only, cross-tenant (bypass GUC), reports per tenant:
  - `live` — non-expired `clio_memory` rows
  - `recallableToday` — rows with a `clio_memory.embedding` (recallable via path A now)
  - `projectionMissing` / `projectionUnembedded` — rows with no `memory_items` projection / a projection with no `context_embeddings` embedding
  - **`wouldDropOnCollapse`** — rows recallable today that would NOT be recallable via the projection. **This is the gate: it must be 0 for every tenant before recall is re-pointed.** The script sets `exitCode=2` when non-zero so a canary can distinguish "measured, not ready" from a crash.
- Verified: raw-query-only (mirrors the known-good `diag-clio-memory.ts`), prisma client regenerated, zero typecheck errors reference it, `entrypoint.sh` parses. (The 144 project-wide tsc errors are the unbuilt-`@capiro/shared`/`meriv2-core` fresh-worktree gotcha — CI builds those first.)

This is the piece that was actually missing: **you cannot safely flip what you have not measured.**

---

## 3. The reconcile step already exists (no new code)

`refresh-memory-graph --all-tenants` → `MemoryIngestService.backfillCurrentTenant()` re-projects every `clio_memory` row into `memory_items` **and** re-embeds it into `context_embeddings` (Phase F, `embedAndUpsert`, idempotent via content-hash). Running it drives `projectionMissing`/`projectionUnembedded` → 0. It's already a nightly EventBridge job. So "reconcile to parity" = run it (on-demand or let the nightly run catch up), then re-measure with §2's diagnostic.

---

## 4. The cutover — 4 steps, reversible until the last

```
1. MEASURE     diag-memory-recall-parity  →  read wouldDropOnCollapse per tenant   [BUILT]
2. RECONCILE   refresh-memory-graph --all-tenants  until wouldDropOnCollapse = 0    [existing tooling]
3. RE-POINT    flag-gated: semanticMemorySearch reads the projection, not clio      [CODE — gated §5]
               MEMORY_RECALL_SOURCE = clio (default) | union | projection
4. RETIRE      migration: clio_memory writes stop being the source (view/compat)    [MIGRATION — gated §5]
```

**Step 3 design (the reversible bridge):** a `MEMORY_RECALL_SOURCE` env/tenant flag, default `clio` (today's behavior, zero change on land):
- `clio` — read `clio_memory.embedding` (OpenAI), as now.
- `union` — read BOTH paths and dedupe by memory key; a **superset**, so nothing can drop — the safe transition state. Flip here first, watch for divergence.
- `projection` — read only `memory_items`+`context_embeddings` (Titan). The actual collapse. Flip only after `union` shows the projection alone returns the same top-K.

Landing step 3 is safe (inert at default `clio`); the *flip* is the reversible lever (change the flag, no redeploy). Step 3 MUST also switch the query-embedding to Titan + re-tune the threshold when in `union`/`projection` mode (§1's gotcha) — reuse the `search_memory` tool's existing Titan query path rather than re-implementing.

**Step 4** is the only hard-to-reverse step: a migration that stops `clio_memory` being an independent source (either make it a view over `memory_items`, or keep the table as a compat write-target but remove it from every read path). Author it, clone-rehearse it, ship it in a scheduled window — and only after step 3 has run stable in `projection` mode for a real traffic cycle.

---

## 5. Gates (non-negotiable, per repo discipline)

Every prior memory change in this repo (including the `clio_memory` RLS rollout itself) was clone-rehearsed against an Aurora copy-on-write clone with a post-deploy canary, and no migration reached prod without a scheduled window + Ninja's explicit go ([[project_memory_hardening]], [[infra_sqlexec_dbhost_secret_beats_override]]). This cutover is the same class. Specifically:

- **Step 3 flip to `union`/`projection`:** gated on `diag-memory-recall-parity` reading `wouldDropOnCollapse = 0` for every tenant (run it as the pre-flip check + wire it as a canary).
- **Step 4 migration:** gated on (a) step 3 stable in `projection` for ≥1 full traffic cycle, (b) clone rehearsal proving recall parity on real data, (c) a scheduled prod window, (d) Ninja's go.
- I am **not** shipping steps 3–4 blind from this worktree — I can't reach prod Aurora or rehearse here, and the query-embedding-model switch (§1) is subtle enough that it must be verified against real vectors, not assumed.

---

## 6. Open decisions for Ninja

1. **Step 4 shape:** make `clio_memory` a literal SQL view over `memory_items`, or keep it as a write-only compat table removed from all read paths? (The latter is lower-risk — no view-vs-table semantics to reconcile — and keeps the existing dual-write idempotency.)
2. **Threshold re-tune:** the OpenAI `>0.3` cosine filter almost certainly needs a different value for Titan vectors — decide whether to tune empirically during the `union` phase (recommended) or pick a conservative default up front.
3. **Client-scope + expiry parity:** confirm the projection-side recall reproduces `clio_memory`'s scope predicates exactly (firm / user_private+owner / client+clientId / non-expired). The `memory_items` RLS now owner-gates at the DB (`current_user_id()`), but client-scope + `expiresAt` semantics on the projection side must be verified in the `union` phase before dropping the clio path.

---

## 7. Bottom line

The collapse is now **de-risked, not done**: the measurement gate that was missing exists and is verified; the reconcile tooling already exists; the recall re-point is designed as a flag-gated, superset-first, reversible bridge; and the only hard-to-reverse step (the migration) is gated exactly as every prior memory change in this repo has been. The next concrete action is operational, not code: run `diag-memory-recall-parity` against prod (as a `diag-*` one-off ECS task), read `wouldDropOnCollapse`, and `refresh-memory-graph` until it's 0 — then Ninja schedules the step-3 flip.
