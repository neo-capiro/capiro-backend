# Phase 3 Deployment Plan — Make Workspace Trustworthy

**Source documents:**
- [`docs/plans/2026-07-12-capiro-strategic-blueprint-execution-plan.md`](2026-07-12-capiro-strategic-blueprint-execution-plan.md) — Phase 3 ("Make Workspace trustworthy, weeks 8–14").
- [`docs/plans/2026-07-12-capiro-phase-2-context-compiler-auditor-deployment-plan.md`](2026-07-12-capiro-phase-2-context-compiler-auditor-deployment-plan.md) / [`...phase-2-5-...md`](2026-07-12-capiro-phase-2-5-grounding-master-plan-completion.md) — the grounding/citation/evidence infrastructure this phase reuses rather than rebuilds.
- [`docs/plans/2026-07-12-capiro-phase-1-memory-ledger-deployment-plan.md`](2026-07-12-capiro-phase-1-memory-ledger-deployment-plan.md) — the candidate lifecycle this phase's memory write-back plugs into.

**Status:** PROPOSED — awaiting Ninja sign-off, in particular §3's D1 (the `gates: []` reversal question — see below, this is a real product-decision tension, not just an engineering gap).

---

## 0. Why this phase is more "connect existing pieces" than "build from scratch"

Workspace (`apps/workspace`, a separate Fargate NestJS service at `/workspace-api/*`) is architecturally mature — real doc generation, DOCX/PDF/server-rendered export, version history, collaboration with edit-lock, an 11-check quality-scoring system, a per-tenant-key AI credential path, and (per direct code read) an existing cross-service pattern for reading `memory_items` under RLS that this phase's write-back workstream can mirror. What it lacks is entirely in the *trust surface*: no claim-level citations, no real risk-tiered approval gate, no visibility into what context influenced a draft, and no way for an approved artifact to feed back into institutional memory. All four gaps are things Phase 2/2.5 already built the underlying machinery for — this phase's job is mostly wiring, not invention.

**One correction to the source blueprint's framing, surfaced by reading the actual code:** the "dead `gates: []` mechanism" is not abandoned or forgotten code. It's a **deliberate Ninja decision**, documented in the code itself (`checks.service.ts:248-251`): *"Human sign-off gates removed: they were hardcoded 'notable' (never clearable) and only added friction... The live rule-based `checks` above are the real signal."* This phase is not fixing a bug — it's asking whether to reintroduce a gate, now *smarter* (tied to risk tier, not a blanket always-on nag). That's a real product-decision tension to put in front of Ninja explicitly (D1), not something to build over quietly.

---

## 1. Current-state verification (code-verified 2026-07-12)

| Area | State | Evidence |
|---|---|---|
| Claim-level citations | **Do not exist.** `generation.service.ts` has exactly one PE-code structural-vetting check (flags a PE code mentioned in text that isn't among the draft's linked PEs) — a narrow, PE-specific warning, not a citation system. No per-sentence evidence pointer, no `[S:tool:record]`-style token, nothing resembling `CitationAnchor` from Phase 2/2.5. | `generation.service.ts:422-429` (comment: "a bare-code citation we can't structurally vet but should not silently pass"), confirmed no `citation`/`Citation`/`claimId` hits elsewhere in the file. |
| Approval/sign-off gate | **Deliberately removed, not forgotten.** `checks.service.ts:252` returns `gates: []` hardcoded, with an explicit code comment explaining *why* (friction, never-clearable, no real signal). 11 live rule-based checks (`placeholders`, `anonymize-map`, and 9 others) still compute a real `score: {passed, total}` — this part is genuinely working and should not be torn out. | `checks.service.ts:75-254` (11 `this.check(...)` call sites), `:246-254`. |
| Risk-tier concept | **Does not exist anywhere in Workspace.** No `riskTier`/`risk_tier` field, no Low/Moderate/High/Restricted concept on `WsDraft` or the product catalog. | Confirmed via repo-wide grep, zero hits in `apps/workspace/src`. |
| "Context used" panel | **Does not exist.** The Context Builder UI lets a user *add* context items (`ws_context_item`), but there's no read-back surface showing which items a specific generated draft actually drew from, nor an exclusions view. | `context.service.ts` (`listItems`/`addItem`/`removeItem` only — no "used in this draft" query); confirmed no matching web component. |
| Context-sourcing "mock" stubs | **Real, but already dead code, not an active trust gap.** The engine's `ContextService.sources()`/`.news()` (`context.service.ts:22-71`) return hardcoded `mock: true` stubs — but the frontend's own code comment confirms these are **no longer consumed**: *"The engine's mock /context/sources + /context/news endpoints are no longer consumed — the Context Builder now sources real client data from the MAIN api directly."* Users are not seeing fake data today; this is unreferenced dead code, a cleanup item, not a live gap. | `context.service.ts:12-17, 22-71`; `apps/web/src/pages/workspace/api.ts:650-653`. |
| Memory write-back (one-way flow) | **Confirmed one-way, read-only.** `generation.service.ts`'s `loadSteeringMemories` reads `memory_items` (firm-soul/firm-compass/user-voice) directly via a raw cross-service query that manually sets the `app.current_tenant` RLS GUC (mirroring `apps/api`'s `PrismaService.withTenant` pattern, since `apps/workspace` has no RLS of its own on its `ws_*` tables). **No code path writes anything back.** This same GUC-mirroring pattern is a usable precedent for the write-back workstream. | `generation.service.ts:556-584` (full read implementation, explicit comment about mirroring `withTenant`). |
| Approval-risk mapping opportunity | The existing 10-product catalog (NDAA Auth Request, Appropriations Justification, CDS/Earmark, Authorization Bill Language, Report Language Request, Meeting Brief & Advocacy, Member letter, Written testimony, One-pager, Strategy memo) maps cleanly onto blueprint Table 10's Low/Moderate/High risk tiers by product type — none of Workspace's own outputs are "Restricted" (that tier is sending/filing/committing positions, which is Phase 2's outreach territory, not Workspace's DOCX/PDF export). | `project_workspace_decisions` memory (10-product catalog); blueprint Table 10 (risk tiers + required control). |
| Existing "Reviewer" role | **A different, narrower thing than a document sign-off gate.** The Reviewer role's "approve" already means approve/reject individual **Meri-suggested edits** in the in-editor assistant — not an overall document publish/export gate. Don't conflate the two when designing the new risk-tier gate. | `project_workspace_decisions` memory. |

---

## 2. Objective

> Blueprint §6.2: *"Citations at the claim, sentence, table cell, or paragraph level... A Context used in this draft panel... A proposed-memory-update panel that separates artifact approval from durable memory promotion."*
> Blueprint §3.3 (Table 10): risk-tiered approval — Low/Moderate/High/Restricted, each with its own required control.
> Blueprint §12.5 gate #2: *"Do not treat Artifact Studio as context-aware until it has parity with Meri chat for approved client strategy, prior artifacts, user voice, and matter scope."*

Directly per the gap-analysis plan's own Phase 3 framing: add claim-level citations (reusing Phase 2/2.5's grounding infra), replace the removed gate with a real risk-tiered one, ship a v1 "Context used" panel, and close the memory write-back loop.

---

## 3. Decisions needed before/at kickoff (Ninja)

| # | Decision | Recommendation | Why |
|---|---|---|---|
| D1 | **Reintroduce an approval gate at all**, given Ninja explicitly removed the old one as pure friction? | **Yes, but only for High/Restricted-tier products, and only as a real, actionable signal** (specific unresolved citation/check failures listed, not a blanket "notable"), never for Low-tier products (one-pagers, strategy memos keep today's frictionless export). | The old gate's sin was being *unconditional and uninformative* (always "notable," nothing to act on). A risk-tiered gate that only appears for testimony/legislative-language products, and that names exactly what's unresolved, is a different thing — but confirm this reasoning with Ninja rather than assume it. |
| D2 | **Risk-tier assignment per product** — fixed by product type, or user-adjustable per draft? | **Fixed by product type as the v1 default** (Written testimony/Authorization Bill Language/Report Language Request/NDAA Auth Request/Appropriations Justification/CDS-Earmark → High; Meeting Brief/Member letter → Moderate; One-pager/Strategy memo → Low), with a per-draft override available to an admin for edge cases. | Matches blueprint Table 10's own tiering logic; avoids forcing every user to classify every draft manually. |
| D3 | **Memory write-back mechanism** — mirror the existing raw cross-service SQL pattern (`generation.service.ts`'s GUC-setting read), or call a real HTTP endpoint on `apps/api` (Phase 1's new candidate-creation route)? | **HTTP call to Phase 1's `memory_candidate` endpoint.** The existing raw-SQL read pattern is precedented but couples Workspace directly to `apps/api`'s schema; a clean API call is the better boundary for a *write*, especially one that needs to go through Phase 1's candidate/approval lifecycle (duplicate-check, compliance-rule gate), not just a raw insert. | Writes carry more risk than reads; reuse Phase 1's governance machinery rather than bypass it with a raw insert from a different service. |
| D4 | **Citation reuse depth** — build a Workspace-specific citation renderer, or literally reuse Phase 2/2.5's `CitationAnchor`/`EvidencePacket` types and checks? | **Reuse directly.** Import `EvidencePacket`/`CitationAnchor` types from `packages/meriv2-core`, and reuse the `compilePeFundingEvidence`/`compileBillStatusEvidence` adapters for the PE/bill claims Workspace already generates content about — the same content-accuracy classes (stage/vehicle conflation, LI-as-PE) that broke in outreach/alert-memo can break in Workspace's budget-justification and NDAA-request products. | Building a third, parallel citation system for Workspace after Phase 2 built one for chat/outreach/alert-memo is exactly the fragmentation pattern the blueprint calls out. |
| D5 | **Delete the dead mock endpoints** (`context.service.ts` `sources()`/`news()`, `ContextController`'s `/context/sources` and `/context/news` routes)? | **Yes, opportunistically, as a same-week cleanup** — confirmed unreferenced by the frontend. | Zero risk (nothing calls it), and it removes a piece of code that misleadingly looks like an active gap when it's actually already-superseded dead code. |

---

## 4. Non-goals (explicitly deferred)

- Full pre-synthesis ClaimPlan pipeline (Phase 2.5's 2.5-9, held pending its own go-ahead) — Workspace's citation work in this phase is **post-hoc** (audit generated content against evidence after the fact), matching ADR-9's sequencing, not a plan-then-prose rewrite of the generation flow.
- A general-purpose "matter/client scope" access-control tier for Workspace collaboration — out of scope; Workspace's existing per-document collaborator roles are untouched.
- Rebuilding the removed sign-off gate exactly as it was — per D1, this is a **new, smarter** gate, not a revival of the old one.
- Any change to the Reviewer role's existing "approve Meri edit suggestions" mechanism — that's a different, already-working feature; don't conflate it with the new document-level risk gate.

---

## 5. Workstreams

### 3.1 — Claim-level citations

**What:** reuse Phase 2/2.5's grounding primitives rather than build new ones. Wire a `ToolResultLedger`-equivalent for Workspace generation (its evidence sources are narrower than chat's — mainly linked Program Elements and, per-draft, whatever `ws_context_item`s were added) into the existing `compilePeFundingEvidence`/`compileBillStatusEvidence` adapters, and extend `generation.service.ts`'s section-writing prompt to emit citation tokens (reuse the `MERI_GROUNDING_OUTREACH_KERNEL`-style surface block pattern — add a `surface:memo`-equivalent block already defined in the v3 grounding prompt's `<surface_memo>` section, since Workspace's deliverables are structurally the same "memo/briefing/deliverable" surface the grounding prompt already has a block for). Run the Phase 2.5-extended auditor (D1–D14, post-hoc) against generated sections before they're marked "done," surfacing findings as one more entry in the existing `checks` array (reusing the scoring UI, not building a new one).

**Files:** `apps/workspace/src/generation/generation.service.ts` (prompt + ledger construction), `apps/workspace/src/checks/checks.service.ts` (new check entries fed by auditor findings), import path from `packages/meriv2-core` (already a monorepo package, confirm `apps/workspace`'s `package.json` can depend on it — if not already, this is a small dependency-wiring task, same class of gotcha as `apps/api`'s existing `@capiro/meriv2-core` dependency).

**Success criteria:**
- [ ] 3.1.1 A generated section referencing a linked PE's funding carries a citation token traceable to the same `compilePeFundingEvidence` adapter Phase 2/2.5 use elsewhere.
- [ ] 3.1.2 The auditor's D1/D4/D4b/D6/D7/D9/D11 checks (whichever are relevant to budget-justification/NDAA-request content) run against generated Workspace sections and surface as new entries in the existing `checks` scoring array — not a parallel, second UI.
- [ ] 3.1.3 No regression to the existing 11 live checks or their `score: {passed, total}` computation.

### 3.2 — Real risk-tiered approval gate (replaces the removed `gates: []`)

**What:** per D1/D2, add a `riskTier` (derived from product type, admin-overridable) to `WsDraft`. For High/Restricted-tier drafts only, the export/publish action checks: (a) all citation-check findings from 3.1 are resolved or explicitly acknowledged, (b) the existing 11 live checks pass above a threshold, (c) a named reviewer (not just "any editor") has approved. Low/Moderate-tier drafts keep today's frictionless flow — this is the mechanism that avoids repeating the old gate's sin of being unconditional.

**Files:** new migration (`riskTier` column on `WsDraft`, small/additive), `checks.service.ts` (real gate logic replacing the hardcoded `[]`), export/publish route (`drafts.controller.ts` or wherever export is gated), web UI (a real gate state distinct from the removed one — show *what specifically* is unresolved, not a blanket "notable").

**Success criteria:**
- [ ] 3.2.1 A Low-tier draft (e.g., a one-pager) exports with zero added friction versus today.
- [ ] 3.2.2 A High-tier draft (e.g., written testimony) with an unresolved citation finding is blocked from export, with the specific unresolved item named in the UI — not a generic "gates not met."
- [ ] 3.2.3 A named-reviewer approval is recorded and auditable (who, when, what was outstanding at approval time).
- [ ] 3.2.4 Confirmed with Ninja (D1) that this reintroduction is wanted before it ships — this is a product-sensitivity item, not a pure engineering call.

### 3.3 — "Context used in this draft" panel v1

**What:** the cheapest, highest-value slice per the blueprint's own §6.2 framing ("even just listing which memory/context items were pulled in delivers most of the trust value"). List, per draft: which `ws_context_item`s were present at generation time, which `memory_items` (firm/user-voice) were injected via `loadSteeringMemories`, and — once 3.1 ships — which evidence packets backed which citations. Exclusions view (what was available but not used) can follow in a later increment, per the blueprint's own sequencing language.

**Files:** new read endpoint (e.g. `GET /workspace-api/drafts/:id/context-used`), a new web panel component in the editor/preview surfaces.

**Success criteria:**
- [ ] 3.3.1 A reviewer can open any generated draft and see, in one place, every context item and memory source that influenced it.
- [ ] 3.3.2 The panel updates correctly across regeneration (stale entries from a prior generation don't linger).

### 3.4 — Close the one-way memory flow

**What:** per D3, when a draft is approved (High/Restricted tier, tied to 3.2's gate) or explicitly promoted by a user, call Phase 1's new candidate-creation endpoint (`apps/api`'s `memory_candidate` route) with the draft's key facts/positions as a proposed memory candidate — reviewed separately from the artifact approval itself, exactly matching blueprint §6.4's "artifact approval and memory promotion are different decisions."

**Files:** `apps/workspace/src/generation/generation.service.ts` or a new `memory-promotion.service.ts`, an HTTP client to `apps/api`'s new Phase-1 candidate endpoint (service-to-service auth — check whether an existing service-to-service credential pattern exists, e.g. how the workspace-collab email module calls back into `apps/api` per the notification-system precedent, reuse that pattern rather than invent a new one).

**Success criteria:**
- [ ] 3.4.1 Approving a High-tier draft creates a real `memory_candidate` row (via Phase 1's endpoint, not a raw insert) with correct provenance (source=workspace, draftId, approver).
- [ ] 3.4.2 The candidate goes through Phase 1's own approval flow (admin review for firm-scope, etc.) — this workstream does not bypass that gate.
- [ ] 3.4.3 A user can decline to promote a fact to memory while still approving the artifact itself — the two decisions are genuinely separable in the UI.

### 3.5 — Cleanup: delete the dead mock context endpoints

**What:** per D5, delete `ContextService.sources()`/`.news()` and the `ContextController`'s `/context/sources`/`/context/news` routes — confirmed unreferenced.

**Success criteria:**
- [ ] 3.5.1 Routes removed; `apps/web` typecheck/build unaffected (confirming the "no longer consumed" comment was accurate).

---

## 6. Sequencing

| Weeks | Work | Depends on |
|---|---|---|
| 1 | D1–D5 sign-off. 3.5 (dead-code cleanup) ships immediately, independent of everything else. | — |
| 1–2 | Confirm `apps/workspace` can depend on `packages/meriv2-core` (dependency wiring check) — do this before 3.1 starts, it's a prerequisite, not part of the citation work itself. | — |
| 2–4 | 3.1 (claim-level citations) — the largest single piece, reuses Phase 2/2.5 infra. | meriv2-core dependency confirmed. |
| 3–4 | 3.3 ("Context used" panel) — can run in parallel with 3.1, lower complexity. | — |
| 4–5 | 3.2 (risk-tiered gate) — needs 3.1's citation findings as one of its gate inputs. | 3.1. |
| 5–6 | 3.4 (memory write-back) — needs Phase 1's candidate endpoint to exist. | Phase 1 shipped; 3.2 (ties promotion to the approval moment). |

---

## 7. Rollout mechanics (repo-specific, non-negotiable)

- **Workspace deploys separately from `apps/api`/`apps/web`** — CI builds `workspace-image` independently; a migration needs the dedicated `capiro-dev-workspace-migrate` one-off ECS task run **before** rolling `capiro-dev-workspace` serve (established gotcha: `serve` mode does not run migrations itself).
- **3.1's `meriv2-core` dependency** needs `apps/workspace/Dockerfile` updated to build+copy the package, mirroring the exact gotcha already documented for `apps/api` (`infra_api_dockerfile_workspace_deps` memory) — verify with a clean `nest build`, not just local typecheck.
- **3.4's service-to-service call** to `apps/api` needs whatever auth pattern the existing workspace→api email-invite call already uses (per the `E-19` notification-system precedent) — reuse it, don't invent a new credential path.
- Canary tenant: `capiro-internal` first for the risk-tier gate (3.2) specifically, since it's the one workstream that can visibly block a real export.

---

## 8. Rollback

| Workstream | Rollback |
|---|---|
| 3.1 (citations) | Revert the branch; generation reverts to today's uncited output. No data loss. |
| 3.2 (risk gate) | Feature-flag the gate check (per-tenant or global) so it can be disabled instantly without a redeploy if it proves too strict — learn from the old gate's own failure mode. |
| 3.4 (memory write-back) | Revert the branch; no candidates are created. Any already-created candidates remain in Phase 1's normal pending/approved state — no cleanup needed since they went through the real candidate lifecycle, not a raw insert. |
| 3.5 (cleanup) | Revert the branch; trivial. |

---

## 9. Testing & verification checklist

- `pnpm --filter @capiro/workspace typecheck` + existing test suite green, plus new suites for 3.1's citation checks and 3.2's gate logic.
- A generated Written-testimony draft, deliberately fed a stale/reversed PE funding fact, should have its citation check flag it (proving 3.1 actually reuses Phase 2's D4 direction check, not a no-op wrapper).
- Manual demo: generate a One-pager (Low tier) → confirm zero added friction on export; generate a Written Testimony (High tier) with an unresolved finding → confirm export is blocked with a specific, actionable message; resolve it → confirm export proceeds.

---

## 10. Phase 3 exit gate — success criteria

- [ ] **G1.** At least one Workspace product category has real claim-level citations, reusing (not duplicating) Phase 2/2.5's grounding types and checks.
- [ ] **G2.** A risk-tiered approval gate exists, is confirmed wanted by Ninja (D1), applies only to High/Restricted products, and never adds friction to Low-tier exports.
- [ ] **G3.** A "Context used in this draft" panel is live for at least the memory/context-item sources (evidence-packet citations may trail if 3.1 lands after).
- [ ] **G4.** An approved High-tier draft can propose a memory candidate through Phase 1's real candidate lifecycle — not a bypass insert — with artifact approval and memory promotion staying separately decidable.
- [ ] **G5.** The dead mock context endpoints are deleted.
- [ ] **G6.** Zero regression to the 11 existing live checks, the export flow for Low/Moderate-tier products, or the unrelated Reviewer-role Meri-suggestion-approval feature.

*Directly answers blueprint §12.5 gate #2 ("Artifact Studio... parity with Meri chat for approved client strategy, prior artifacts, user voice, and matter scope") for the context-visibility half; full parity (the shared Context Compiler from Phase 2) is a longer-running convergence, tracked there, not restated here.*

---

## 11. Metrics to instrument (blueprint Table 51, scoped to this phase)

- **Citation coverage in Workspace output**: 0% today → target meaningfully >0% on High-tier products (the gap-analysis plan's own named metric).
- **Gate false-positive rate**: track how often the new risk-tier gate blocks an export that a human reviewer then approves without any real change — a high rate here means the gate is repeating the old one's mistake and needs tuning, not just existing.
- **Memory-promotion rate from Workspace**: 0 today → first nonzero count once 3.4 ships.

---

## 12. Risks specific to this phase

- **D1 is a real product-sensitivity question, not a technical one** — Ninja removed the old gate for a reason; shipping a new one without explicit sign-off risks repeating a friction complaint that was already resolved once.
- **3.1's dependency on `packages/meriv2-core`** is new for `apps/workspace` — confirm the Docker build actually includes it before assuming the citation logic will run in prod (the exact class of gotcha that has bitten `apps/api` before).
- **3.4's cross-service write** must go through Phase 1's real candidate lifecycle (D3) — a shortcut raw insert would recreate the exact "fire-and-forget direct write" anti-pattern Phase 1 exists to close, just from a second service instead of one.
- **The gate (3.2) must stay tier-scoped** — if implementation drift causes it to apply to Low/Moderate-tier products too, this phase silently re-introduces the exact friction Ninja already rejected once.
