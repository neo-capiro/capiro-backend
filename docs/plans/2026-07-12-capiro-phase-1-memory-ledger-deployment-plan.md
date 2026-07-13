# Phase 1 Deployment Plan — One Memory, One Ledger

**Source documents:**
- `Capiro_Strategic_Product_and_Growth_Blueprint_v2.docx` (rev. July 12, 2026) — §4.6, §5, §12.5, §12.8, Tables 18–20, 24, 51, Appendix C.
- [`docs/plans/2026-07-12-capiro-strategic-blueprint-execution-plan.md`](2026-07-12-capiro-strategic-blueprint-execution-plan.md) — the 9-pillar gap analysis; this document expands that plan's Phase 1 section (§3, "One memory, one ledger, weeks 1–6") into a fully scoped deployment plan.
- `~/.hermes/plans/2026-07-05-institutional-memory-hardening-plan.md` — the prior hardening project (Phases 0–6, shipped to prod 2026-07-05). Phase 1 below builds directly on top of that work; it does not repeat it.

**Status:** PROPOSED — awaiting Ninja sign-off on §3 (Decisions) before any branch work starts.
**Verification basis:** every claim about current code state below was checked directly against `origin`-tracked source in this worktree on 2026-07-12 (file:line citations throughout), not inferred from the gap-analysis doc alone.

---

## 0. Why this isn't a Days 0–30 greenfield plan

The blueprint's own Table 48 ("Days 0-30: establish the memory contract") assumes a standing start. Capiro isn't at one: a full hardening pass (`2026-07-05-institutional-memory-hardening-plan.md`, PRs #245/#246) already shipped RLS on `clio_memory`, write-through sync into `memory_items`, a CI owner-gating test, and an admin-gate on firm-scope writes — all live in prod today. That changes what Phase 1 actually has to build. §1 below is a precise accounting of what's already true vs. what's still missing, because the effort estimate depends entirely on getting that split right.

---

## 1. Current-state verification (code-verified 2026-07-12)

| Area | State | Evidence |
|---|---|---|
| `clio_memory` RLS | **LIVE.** `ENABLE`+`FORCE ROW LEVEL SECURITY`, tenant-isolation policy, partial-unique dedup index pair. All 7 src callers + 2 scripts confirmed scoped via `withTenant`/`withSystem`. | Hardening plan Phase 1 (GAP 3/4), confirmed shipped in `project_memory_hardening` memory (PR #246, migration `20260705120100_clio_memory_rls`). |
| `memory_items`/`memory_edges` write-through | **LIVE.** Every `clio_memory` mutation (`saveMemory`/update/delete) write-throughs to a `memory_items` row + async embedding, fire-and-forget. Nightly `refresh-memory-graph` EventBridge rule live. | Hardening plan Phase 2 (GAP 6/7); `meri-tools.service.ts` saveMemory (below). |
| Private-item read gating | **Query-level only**, backed by a CI test that scans source for the filter pattern (`memory-private-fail-closed.spec.ts`) — not a DB predicate. `memory_items` RLS itself is **tenant-only**; there is no owner predicate at the Postgres layer. | `memory-store.service.ts:60-77` manually ANDs `(visibility = 'tenant' OR owner_user_id = ${ctx.userId})` into every raw SQL read; hardening plan's own Phase 3 note: *"private items rely on query-level owner filtering."* Hardening plan explicitly chose **3a** (CI-test hedge) over **3b** (structural DB predicate) — see its Decision log. |
| Firm-scope write governance | **Binary admin-gate**, not an approval queue. `saveMemory` rejects a non-admin firm-scope save with a fixed message; there is no pending/approval record. | `meri-tools.service.ts:1478-1496` (`isAdmin` check, `record.scope === 'firm' && !isAdmin` → reject). Hardening plan chose **4a** (admin-gate) over **4b** (approval-queue). |
| Candidate lifecycle for memory writes | **Does not exist.** `saveMemory` is a direct find→update-else-create straight into `clio_memory` (then write-through). No provenance capture beyond a fixed `{tool, createdBy, userId, visibility}` metadata blob, no duplicate/contradiction step beyond the upsert-by-key collision. | `meri-tools.service.ts:1478-1555`. |
| Canonical memory-record fields (validity/status/supersession/governance) | **Missing entirely.** `MemoryItem` has only `id/tenantId/clientId/ownerUserId/type/visibility/entityId/slug/title/aliases/tags/source/sourceRef/provenance/sections/schemaVersion/createdAt/updatedAt`. No `validFrom/validTo`, `status`, `lastConfirmedAt`, `supersedesId`, `contradictsId`, `sensitivity`, `retentionPolicy`, `legalHold`, `revokedAt`, `exportable`, or `trainingUse`. | `schema.prisma:4987-5013` (full field list); `memory.types.ts:76-95`. This is the single largest concrete gap against blueprint **Table 19** ("Canonical memory model"). |
| User-facing memory verbs (confirm/correct/forget/export) | **Zero wired.** `memory-governance.helpers.ts` (`selectForPurge`, `selectForClientPurge`, `selectForUserPurge`, `selectForLegalHold`, `redactSections`, `toManifestRow`) has **no callers anywhere in `apps/api/src`** outside its own spec file (repo-wide grep confirmed). `memory.controller.ts` has 10 routes (`catalog`, `items`, `items/:type/:slug/markdown`, `.../sections`, `interview/*`, `graph`, `graph/client/:id`, `graph/path`, `backfill`) — none are purge/forget/export/confirm/correct. | `memory-governance.helpers.ts` (full file, 91 lines); `memory.controller.ts:1-30` (route list in header comment, verified against decorators). |
| Reusable candidate/approval infrastructure elsewhere in the codebase | **Exists and is a good fit.** `packages/meriv2-core/src/compliance/compliance-rules.ts` — a declarative PASS/WARN/BLOCK rule engine, first-match-wins, every decision carries an auditable rule id. `approval-gate.ts` — `PolicyApprovalGate`/`ApprovalStore`, `ComplianceBlockedError`/`ApprovalPendingError`. `registry/types.ts` — `ToolDefinition<I,O>` requires a `MeriContext` at the type level; write tools (`readOnly:false`) route through the gate automatically. | Read directly; `approval-gate.spec.ts:29-58` demonstrates PASS/BLOCK/WARN-pending/WARN-approved behavior end to end. |
| `meri_audit_ledger` | **Unrelated to memory** — confirmed a separate, immutable, append-only per-turn claim/verdict trail (no title/slug/sections/provenance, no update path), not a memory store. Useful only as a second working example of the RLS pattern. | `schema.prisma:1656-1686`; migration `20260712000000_meri_audit_ledger`. |
| Generic audit-log table | **Exists, tenant-scoped, exactly fits a "forget" tombstone.** `AuditLog`: `tenantId`, `actorUserId`, `actorRole`, `action`, `entityType`, `entityId`, `before`/`after` jsonb, `occurredAt`. | `schema.prisma:1801-1821` (table `audit_logs`). |
| RLS session mechanism | `withTenant(tenantId, fn)` opens a transaction and runs `SELECT set_config('app.current_tenant', tenantId, true)` (transaction-local `SET LOCAL` semantics); `withSystem(fn)` sets `app.bypass_rls = 'on'`. SQL helpers `current_tenant_id()` and `rls_bypass()` read those GUCs. **No third GUC for the acting user exists today** — `withTenant` takes only `tenantId`. | `prisma.service.ts:38-105`; SQL functions at `20260501000000_init_identity_tenancy/migration.sql:172-192`. |
| Memory-class taxonomy vs. blueprint Table 18 | `MemoryItemType` already covers ~5 of the blueprint's 6 classes: `firm-soul/firm-compass/playbook`→Firm constitutional; `client-hub/client-soul/client-compass/client-people/client-profile`→Client strategic; `user-profile/user-voice`→User; `meeting/debrief/thread/meri-session`→Episodic; `person/bill/issue`→Evidence-adjacent. **Working memory (ephemeral task state) has no representation** — consistent with "Use once" correctly not persisting, but the blueprint's Table 18 describes it as a class workflow runtime should still track, which Capiro doesn't today. | `memory.types.ts:20-38`. |
| Matter/client scope as an access-control tier | **Does not exist as enforcement** — only two visibilities (`tenant`, `user`); `clientId` is a filter tag, not an access boundary (no query enforces "only users on this matter may read"). Blueprint Table 24 lists 8 scope tiers; Capiro effectively has 2 enforced + 1 unenforced tag. | `memory.types.ts:41` (`MemoryVisibility = 'tenant' \| 'user'`). |

---

## 2. Objective — what "Phase 1 done" must prove

Directly from the blueprint:

> §12.5 gate #1: *"Do not position institutional memory as a moat until private scopes are database-enforced and users can inspect, correct, and revoke memory."*
> §12.8 priority #9: *"Enforce user-private and matter-restricted memory at the database boundary and test privileged paths continuously."*
> Appendix C: *"Are user-private, matter-restricted, legal/compliance, and privileged scopes enforced at the database boundary? Can users inspect what Meri remembers, see what influenced a draft, and confirm, correct, narrow, revoke, or export it?"*

Phase 1 exists to make both of those sentences true — nothing more. Context Compiler, cross-surface parity, and Workspace citations are explicitly out of scope (§4).

---

## 3. Decisions needed before/at kickoff (Ninja)

| # | Decision | Recommendation | Why |
|---|---|---|---|
| D1 | **Canonical-ledger framing.** The blueprint literally says "clio_memory becomes a write-through view feeding memory_items." | **Refine, don't reverse.** Keep `clio_memory` as Meri's fast KV write/recall path (it's stable, just RLS-hardened 5 weeks ago). Designate `memory_items` as canonical for **governance** — it's the row that carries validity/status/supersession/retention metadata (§5.1A) and the row every user-facing verb acts on. The write-through direction (`clio_memory` → `memory_items`) stays as-is. | Literally flipping the write path re-architects a subsystem that was just stabilized, for no governance benefit — the governance metadata can live on the projection row exactly as well as on the source row. |
| D2 | **Private-scope enforcement mechanism** for the 3a→3b upgrade (§5.1C). | **Postgres RLS with a third GUC**, mirroring the existing `app.current_tenant`/`app.bypass_rls` pattern exactly (add `app.current_user`). | Consistency with an already-proven, already-audited mechanism beats inventing a parallel one (e.g., a locked-down view). |
| D3 | **Candidate/contradiction-check depth** for Phase 1. | **Minimal**: key-collision duplicate detection (already exists as an upsert path — formalize it as an explicit step) + a same-key/different-value contradiction flag, surfaced to a reviewer, not auto-blocked. | Semantic contradiction detection needs retrieval/ranking machinery that belongs to Phase 2's Context Compiler — don't build it twice. |
| D4 | **Firm-memory governance** — keep 4a (admin-gate) standalone, or fold it into the new candidate/WARN mechanism? | **Fold it in.** Once a candidate table + compliance-rule gate exist (§5.1B), the bespoke `if (scope==='firm' && !isAdmin)` reject-branch becomes redundant with a `WARN` rule outcome. Delete the old branch; don't maintain two governance paths. | One code path for "this write needs approval" is easier to audit and extend than two. |
| D5 | **Which surface gets the first verbs?** | **Chat only** (matches the gap-analysis plan's own call), reusing the existing Settings `MemoryFileEditor.tsx` for the confirm/forget affordance rather than building new chat-bubble UI. | Keeps Phase 1 inside its 6-week box; a UI treatment is not part of the blueprint's gate — the *action existing and working* is. |
| D6 | **Matter/client scope enforcement.** | **Defer full enforcement to Phase 2.** Phase 1's forget/purge verbs *do* use the already-correct `selectForClientPurge`/`selectForLegalHold` selectors (they're unwired, not wrong), but Phase 1 does not add a new access-control tier. | The blueprint's own gate (§12.5 #1) is about private/user scope, not matter scope — don't scope-creep the highest-risk phase. |

---

## 4. Non-goals (explicitly deferred)

- Context Compiler, token-budgeted retrieval, cross-surface context parity (Phase 2).
- Workspace/Artifact Studio citations and "Context used" panel (Phase 3).
- Full matter/client access-control tier (Phase 2 — see D6).
- Semantic contradiction detection (needs Phase 2's retrieval/reranking).
- Re-enabling meri-session client-linking — still deferred per the hardening plan, but workstream 1C's structural owner-gating is exactly the precondition the hardening plan named for lifting that deferral. Flag it as a Phase-2 candidate once 1C ships, not a Phase 1 deliverable.
- Compliance-assistance module (Phase 5, correctly sequenced last).

---

## 5. Workstreams

### 1A — Canonical record model: governance/temporal columns (schema, additive)

**What:** one additive migration on `memory_items` adding: `status` (`active|superseded|revoked`, default `active`), `lastConfirmedAt`, `reviewCadenceDays` (nullable), `supersedesId` (nullable self-FK), `contradictsId` (nullable self-FK), `sensitivity` (default `normal`), `retentionPolicy` (jsonb, nullable), `legalHold` (bool, default `false`), `revokedAt`/`revokedBy` (nullable), `exportable` (bool, default `true`), `trainingUse` (default `excluded`, per blueprint §5.3's "no silent platform training"). **Not** duplicated onto `clio_memory` — governance metadata lives only on the canonical row (reinforces D1).

**Files:** `apps/api/prisma/schema.prisma`, new migration dir, `memory.types.ts` (extend `MemoryItem`), `memory-store.service.ts` (`rowToItem` mapping), `memory-governance.helpers.ts` (extend selectors to respect `status`/`legalHold`/`retentionPolicy`).

**Success criteria:**
- [ ] 1A.1 New columns exist on `memory_items`; `prisma migrate diff` empty, proven on a fresh scratch DB.
- [ ] 1A.2 `typecheck` 0 new errors; existing memory jest suite green with the extended `MemoryItem` type.
- [ ] 1A.3 Clone run confirms defaults populate correctly on existing rows (no null-constraint surprises).
- [ ] 1A.4 `memory-governance.helpers.ts` selectors updated to exclude `legalHold=true` rows from purge and `status='revoked'` rows from normal read paths; unit-tested.

### 1B — Candidate lifecycle (`memory_candidate` table + reused compliance gate)

**What:** new table `memory_candidate`: `id`, `tenantId`, `proposedBy`, `sourceKind` (`explicit_user|workflow_event|artifact_approval|model_extraction`), `scope` (`personal|firm`), `payload` (jsonb), `provenance` (jsonb: source ref, evidence span), `duplicateOfId?`, `contradictsId?`, `status` (`pending|approved|rejected|auto_committed`), `decidedBy?`, `decidedAt?`, `committedItemId?`, `createdAt`.

Reuse, don't reinvent: model the gate as a `ComplianceRule` set in `packages/meriv2-core/src/compliance/compliance-rules.ts` — `PASS` for personal-scope explicit saves (preserves today's latency/behavior exactly), `WARN` for firm-scope (replaces the current fixed-rejection branch with a real pending-approval record an admin can act on, via the existing `PolicyApprovalGate`/`ApprovalStore` shape). Extract the rule-evaluation as a plain function callable from **both** the MeriV2 tool registry and the legacy `meri-tools.service.ts` handler — MeriV2 full-chat is live for only one tenant today, so the legacy surface cannot depend on a MeriV2-only invocation path.

Rewire `saveMemory` (`meri-tools.service.ts:1478-1555`) to create a candidate first; auto-commit inline (same transaction, no added round-trip) for the `PASS` path so personal-scope latency is unchanged; firm-scope creates a `pending` candidate and returns the same shape of message the tool already returns today, just backed by a real row instead of a dead end.

**Files:** `schema.prisma`, migration, new `memory-candidate.service.ts`, `meri-tools.service.ts` (saveMemory rewrite), `compliance-rules.ts` (new memory-candidate ruleset), new `GET/POST /memory/candidates` admin routes on `memory.controller.ts` (list pending, approve/reject).

**Success criteria:**
- [ ] 1B.1 Personal-scope `save_memory` behavior and latency are unchanged (integration test diff against pre-Phase-1 baseline).
- [ ] 1B.2 Firm-scope `save_memory` creates a real `memory_candidate` row (`status='pending'`) instead of a dead-end rejection message.
- [ ] 1B.3 An admin can list pending candidates and approve one; approval commits through the *existing* Phase-2 write-through path (no new commit logic duplicated).
- [ ] 1B.4 Duplicate detection: saving the same key twice sets `duplicateOfId` rather than silently double-writing.
- [ ] 1B.5 The old `if (record.scope === 'firm' && !isAdmin)` branch (`meri-tools.service.ts:1489-1496`) is deleted, not left dormant alongside the new path (D4).
- [ ] 1B.6 Rule-evaluation logic is a plain function invoked identically from legacy chat and MeriV2 (one implementation, two callers — verified by a shared unit test run against both call sites).

### 1C — Structural private-scope enforcement (upgrade 3a → 3b)

**This is the highest-risk workstream in Phase 1** and the one the blueprint's gate is actually about.

**What:** add a third session GUC, `app.current_user`, alongside the two that already exist (`app.current_tenant`, `app.bypass_rls` — `prisma.service.ts:38-105`). Extend `withTenant` (or add a `withTenantUser(tenantId, userId, fn)` variant) to also run `SELECT set_config('app.current_user', userId, true)`. Add a matching SQL function:

```sql
CREATE OR REPLACE FUNCTION current_user_id() RETURNS UUID AS $$
DECLARE
  v_raw TEXT := current_setting('app.current_user', true);
BEGIN
  IF v_raw IS NULL OR v_raw = '' THEN RETURN NULL; END IF;
  RETURN v_raw::uuid;
EXCEPTION WHEN invalid_text_representation THEN RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;
```

— copied verbatim in structure from the existing `current_tenant_id()` (`20260501000000_init_identity_tenancy/migration.sql:172-186`).

Add a real RLS policy on `memory_items`:

```sql
CREATE POLICY "memory_items_owner_isolation" ON "memory_items"
  USING (rls_bypass() OR (tenant_id = current_tenant_id()
    AND (visibility = 'tenant' OR owner_user_id = current_user_id())))
  WITH CHECK (rls_bypass() OR (tenant_id = current_tenant_id()
    AND (visibility = 'tenant' OR owner_user_id = current_user_id())));
```

(`memory_items` currently has tenant-only RLS from the original `20260625130000_institutional_memory` migration — this replaces that policy, it doesn't add a second one.) Do the same for `context_embeddings` rows where `source_type='memory_item'`: add a nullable `owner_user_id`, backfill from `memory_items`, predicate `(owner_user_id IS NULL OR owner_user_id = current_user_id())` so shared (non-memory-item) embeddings stay unaffected — this is exactly the 3b design the hardening plan itself sketched and deferred.

Leave the existing manual `AND (visibility = 'tenant' OR owner_user_id = ...)` clauses in `memory-store.service.ts:60-77` in place as defense-in-depth (the blueprint's own Table 17 language: *"database boundary, with application checks as defense in depth"*) — don't strip them just because RLS now also enforces it.

**Rollout discipline — follow the exact playbook the `clio_memory` RLS rollout used** (it worked once already on this codebase): Aurora copy-on-write clone, feat-branch image tagged by SHA (never `:latest`), prove `SELECT 1`, prove a cross-owner `SELECT` with no `app.current_user` set (or the wrong one) returns 0 rows for a private item, prove owner reads and tenant-shared reads are unaffected, wire a post-deploy canary into the existing CloudWatch/SNS alerting (`capiro-dev-alerts`) — a 0-row result after the migration applies is the exact silent-failure mode the `clio_memory` rollout's canary was built to catch.

**Files:** new migration (`current_user_id()` function + `memory_items` policy replacement + `context_embeddings.owner_user_id` backfill+predicate), `prisma.service.ts` (extend `withTenant` / add `withTenantUser`), every call site currently using `withTenant(ctx.tenantId, ...)` for memory reads/writes (pass `ctx.userId` too), `memory-private-fail-closed.spec.ts` (repurpose: assert the policy exists + a live cross-owner query on a test DB returns 0 rows, rather than just scanning source for the filter pattern).

**Success criteria:**
- [ ] 1C.1 `current_user_id()` function ships, mirroring `current_tenant_id()`'s structure exactly.
- [ ] 1C.2 `memory_items` RLS policy replaced (not duplicated) with the owner-aware version; `context_embeddings` owner column backfilled + predicated.
- [ ] 1C.3 Clone-proven: a query with `app.current_user` unset or wrong returns 0 rows for a private item belonging to someone else; the owner's own read still works; tenant-shared (`visibility='tenant'`) reads are unaffected.
- [ ] 1C.4 `withSystem` (bypass) reads still work for backfill/admin jobs — unaffected by the new predicate.
- [ ] 1C.5 Post-deploy canary wired to `capiro-dev-alerts`, green for one full prod traffic cycle before Phase 1 is declared shipped.
- [ ] 1C.6 `prisma migrate diff` empty, proven on a fresh scratch DB.

### 1D — First user-facing memory verbs (chat surface, gated on 1A + 1C)

**What:** four verbs, implemented once as plain service methods (`memory-store.service.ts`) and exposed via both the MeriV2 tool registry (`ToolDefinition<I,O>`, `packages/meriv2-core/src/registry`) and a legacy `meri-tools.service.ts` handler, so they work regardless of which chat surface a tenant is on:

- **`confirm_memory(itemId)`** — sets `lastConfirmedAt = now()`. Low-risk, `PASS`-tier.
- **`correct_memory(itemId, newContent)`** — creates a *new* `memory_items` row; sets the old row's `status='superseded'` and `supersedesId` on the new row pointing at the old — preserves history per blueprint §4.6.5 step 8 / Table 27 ("preserve history through supersession rather than destructive overwrite").
- **`forget_memory(itemId, reason?)`** — implements blueprint §5.4's 5-step model precisely:
  1. Set `status='revoked'`, `revokedAt`/`revokedBy` — stops recall immediately (every read path already filters `visibility`/`owner_user_id`; add `status != 'revoked'` to that same filter as part of 1A).
  2. Write a tombstone to the existing `audit_logs` table (`action='memory.forget'`, `entityType='memory_item'`, `entityId`, `before=`snapshot jsonb, `actorUserId`) — no new table needed (`schema.prisma:1801-1821`).
  3. Synchronously purge derived projections: delete the `context_embeddings` row; `memory_edges` CASCADE automatically from `memory_items` (confirmed FK, `schema.prisma:5030-5032`) — no explicit edge-delete needed, matches the existing Phase-2 delete path in `meri-tools.service.ts` almost exactly.
  4. Respect `legalHold` (1A's new column) — if true, **refuse** the purge step and say so in the tool response, rather than silently no-op.
  5. Leave the canonical row soft-deleted (`status='revoked'`), not hard-deleted — an accidental forget is administratively recoverable; hard purge-on-schedule is a `retentionPolicy` job, out of Phase 1 scope.
- **`export_memory(clientId?)`** — wires the already-built `toManifestRow` (`memory-governance.helpers.ts:77-90`) to a new `GET /memory/export` route, returning the manifest array as JSON.

**Sequencing constraint:** ship 1D *after* 1C, not before. "Forget stops recall immediately" is only true once the DB-level predicate (or at minimum 1A's `status` filter) is live — shipping the verb earlier under schedule pressure would make that claim false.

**UI:** minimal — surface Confirm/Forget on the existing Settings `MemoryFileEditor.tsx` (per D5); a dedicated chat-bubble affordance is a nice-to-have, not required for the Phase 1 gate.

**Files:** new tool files under `packages/meriv2-core/src/tools/memory/`, `meri-tools.service.ts` (parity handlers), `memory.controller.ts` (`/memory/export`, candidate-approval routes from 1B), `memory-store.service.ts` (`confirmItem`/`supersedeItem`/`revokeItem`).

**Success criteria:**
- [ ] 1D.1 Confirm: `lastConfirmedAt` updates; item remains searchable.
- [ ] 1D.2 Correct: old item `status='superseded'`; new item's `supersedesId` points at it; both remain queryable (history preserved).
- [ ] 1D.3 Forget: `search_memory` no longer returns the item; `context_embeddings` row gone; `audit_logs` tombstone present; a `legalHold=true` item refuses the purge with an explanatory response instead of silently no-op'ing.
- [ ] 1D.4 Export: `GET /memory/export` returns a structured manifest row per item, matching `ExportManifestRow`'s shape.
- [ ] 1D.5 Each verb is callable from both legacy chat and MeriV2 chat with identical effect (parity, not just presence on one surface).

### 1E — Firm-memory governance convergence

Fold hardening-plan Phase 4's admin-gate into 1B's candidate/WARN mechanism (D4): delete the old bespoke reject-branch once the new path covers the same case, so there is one governance code path, not two.

**Success criteria:**
- [ ] 1E.1 Grep-verified: the old `if (record.scope === 'firm' && !isAdmin)` branch no longer exists in `meri-tools.service.ts`.
- [ ] 1E.2 A non-admin firm-scope save still cannot silently create firm-wide truth (regression test carried over from the hardening plan's own Phase 4 test).

---

## 6. Sequencing

| Week | Work | Depends on |
|---|---|---|
| 1 | D1–D6 sign-off with Ninja. 1A migration authored + clone-tested. | — |
| 2–3 | 1B candidate lifecycle (code + new table; no RLS risk). | 1A (uses new columns for candidate→commit). |
| 3–4 | 1C structural RLS upgrade — own PR/deploy window, clone-rehearsed, scheduled explicitly. | 1A. |
| 4–5 | 1D user-facing verbs. | 1A + 1C (forget's "stops recall immediately" claim requires 1C). |
| 5–6 | 1E cleanup; end-to-end demo rehearsal against `capiro-internal` (mirrors blueprint §10.6's 9-step governed-memory-loop demo); Phase 1 exit-gate review with Ninja. | 1B, 1C, 1D. |

---

## 7. Rollout mechanics (repo-specific, non-negotiable)

- **Merge ≈ deploy.** The API entrypoint auto-runs `prisma migrate deploy` on every deploy; no migration merges to `main` ahead of its scheduled window. 1A can merge as soon as clone-tested (purely additive, low risk). 1C's migration stays on a feature branch until the clone rehearsal + Ninja go-ahead — identical discipline to the `clio_memory` RLS rollout.
- **`api-image.yml` is path-gated** to `apps/api/**` + `packages/shared/**` — it does **not** include `packages/meriv2-core/**`. 1D's new MeriV2 tools need `gh workflow run api-image.yml -f env=dev --ref main` (workflow_dispatch) or the image silently won't rebuild. Verify `:latest` carries the merge SHA before rolling (ECR tag race).
- **Do not `cdk deploy Capiro-dev-Compute`** for any of this — ship via `scripts/deploy-dev.sh` (migrate→roll api) and out-of-band task-def revisions/EventBridge rules, same as every other recent rollout on this repo.
- **Canary tenant:** `capiro-internal` first for every workstream, matching the established pattern.

---

## 8. Rollback

| Workstream | Rollback |
|---|---|
| 1A | Additive nullable columns — drop them. No data loss beyond the new fields. |
| 1B | Feature-flag the candidate routing so reverting to direct-write is a one-line env flip, not a migration rollback. Drop the table only after confirming no in-flight candidates. |
| 1C | `DROP POLICY memory_items_owner_isolation; ALTER TABLE memory_items DISABLE ROW LEVEL SECURITY;` then restore the prior tenant-only policy (same pattern as `clio_memory`'s own documented rollback). No irreversible step this time — unlike the `clio_memory` GAP 4 dedup DELETE, nothing here destroys data. |
| 1D | Each verb is an isolated tool/route — revert the branch. `forget`'s soft-delete means no data is destroyed even if the surrounding code is rolled back. |

---

## 9. Testing & verification checklist (applies across all workstreams)

- `pnpm --filter @capiro/api typecheck` → 0 new errors.
- `pnpm --filter @capiro/api test` → green, plus new suites for the candidate lifecycle and each verb.
- `prisma migrate diff` → empty, proven on a fresh scratch DB (established gotcha: partial/RLS artifacts can otherwise show spurious drift).
- ECS-clone rehearsal specifically for 1C (Aurora copy-on-write, feat-branch SHA-tagged image, never `:latest`).
- Post-deploy canary wired to `capiro-dev-alerts` for 1C.

---

## 10. Phase 1 exit gate — success criteria

**All of the following must be true before Phase 1 is declared shipped:**

- [ ] **G1.** A private (`visibility='user'`) memory item is enforced at the **database** boundary — a query with no/wrong `app.current_user` GUC returns 0 rows for that item, proven on the ECS-clone (not merely asserted by a CI source-scan). *Answers Appendix C: "Are user-private... scopes enforced at the database boundary?"*
- [ ] **G2.** A user can Confirm, Correct, Forget, and Export a real memory item on the chat surface and observe the correct effect in the same session: `lastConfirmedAt` updates; a corrected item preserves the prior version via `supersedesId`; a forgotten item disappears from `search_memory`, its `context_embeddings` row is gone, and an `audit_logs` tombstone exists; export returns a structured manifest row. *Answers Appendix C: "Can users inspect what Meri remembers... and confirm, correct, narrow, revoke, or export it?"*
- [ ] **G3.** No memory write reaches `memory_items`/`clio_memory` without passing through the candidate/compliance-rule gate — the old direct-write branch and the old ad-hoc admin-reject message are **deleted**, not merely supplemented.
- [ ] **G4.** `memory_items` carries validity/status/supersession/governance metadata (blueprint Table 19's five dimensions) and the new write paths actually populate it — not added-but-unused columns.
- [ ] **G5.** Zero regressions: personal-scope `save_memory`/`search_memory`/backfill/`refresh-memory-graph` behavior is unchanged in latency and output shape (integration-test diff against the pre-Phase-1 baseline).
- [ ] **G6.** The canonical-ledger decision (D1) is recorded in code comments/README, not left implicit.
- [ ] **G7.** The 1C RLS canary is green on prod for one full traffic cycle before the phase is declared shipped — clone-verification alone is not sufficient.

---

## 11. Metrics to start instrumenting (blueprint Table 51, scoped to what Phase 1 makes measurable)

- **Memory-verb coverage:** 0/8 today → target 4/8 (confirm, correct/supersede, forget, export) by end of Phase 1. Remaining four (use-once, remember-for-client as distinct UX, propose-for-firm as distinct UX, full scope picker) are Phase 2 follow-ons.
- **Revocation completion:** time from `forget` call to removal from `search_memory` + `context_embeddings` — target same-request/session (synchronous purge); formalize as a measured SLO once shipped.
- **Scope accuracy / privacy leakage:** target zero cross-owner reads. The G1 clone-test becomes a permanent regression check in CI, not a one-time proof.
- **"Built but dark" backlog** (gap-analysis plan §6): wiring the governance helpers is the single largest item on that list — track it to zero as this phase ships.

---

## 12. Risks specific to this phase

- **1C is the highest-risk single change in Phase 1** — same failure class as the `clio_memory` RLS rollout (a caller that forgets to set the new GUC silently gets 0 rows instead of an error). Mitigated by reusing the identical clone-rehearsal + canary discipline that already worked once on this exact codebase.
- **Sequencing risk:** if 1C slips, there will be pressure to ship 1D's `forget` verb anyway "with the DB fix to follow." Don't — that makes "stops recall immediately" a false claim. This is called out explicitly in §6 so a schedule slip doesn't quietly become a scope cut.
- **Added latency risk:** 1B puts one extra write in front of every `save_memory` call. Confirm it's imperceptible (same transaction, single-digit ms) before shipping; if not, the personal-scope auto-commit path needs to create the candidate + item in one transaction rather than two round-trips (already the intended design in §5.1B, just flagging it as a thing to actually measure, not assume).
- **Cross-surface coupling risk:** reusing `compliance-rules.ts`/`approval-gate.ts` ties memory governance to MeriV2's compliance engine, but MeriV2 full-chat is live for only one tenant today. The rule-evaluation logic must be a plain function both surfaces call (§5.1B.6) — if it accidentally becomes MeriV2-tool-only, legacy chat's `save_memory` silently loses governance instead of gaining it.

---

## 13. Decision log

*(Fill in as Ninja signs off on §3.)*

- [ ] D1 canonical-ledger framing:
- [ ] D2 enforcement mechanism:
- [ ] D3 candidate-check depth:
- [ ] D4 firm-governance convergence:
- [ ] D5 first-surface choice:
- [ ] D6 matter-scope deferral:
