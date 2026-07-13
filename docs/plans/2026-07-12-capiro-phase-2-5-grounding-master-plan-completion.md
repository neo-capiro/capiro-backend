# Phase 2.5 Deployment Plan — Finishing the v3 Zero-Trust Grounding Master Plan

**Source documents:**
- [`docs/plans/2026-07-12-meri-zero-trust-grounding-master-plan-v3.md`](2026-07-12-meri-zero-trust-grounding-master-plan-v3.md) — the authoritative technical plan this phase completes. Every workstream below traces to a specific `[ ]` (not-yet-done) line in that document's §4.1.
- [`docs/plans/2026-07-12-capiro-phase-2-context-compiler-auditor-deployment-plan.md`](2026-07-12-capiro-phase-2-context-compiler-auditor-deployment-plan.md) — Phase 2. This document exists **because** Phase 2 deliberately scoped itself to the blueprint's own gate ("chat + outreach + alert-memo on one context contract") and explicitly deferred the rest of the v3 plan's remaining checklist. Phase 2.5 is that deferred remainder, made explicit so it isn't silently lost.
- [`docs/plans/2026-07-12-capiro-strategic-blueprint-execution-plan.md`](2026-07-12-capiro-strategic-blueprint-execution-plan.md) — the original blueprint gap-analysis; its own "Phase 4 — Finish the moat, converge the runtime" already names two items that overlap with this phase's Tier 3 (Wave 6 convergence, Wave 4 approval-risk model). Flagged explicitly below rather than silently duplicated.

**Status:** PROPOSED — awaiting Ninja sign-off, in particular on the tiering in §3 (this phase is large; not all of it should happen before Phase 3).

---

## 0. Why this phase exists, and why it isn't "finish everything"

The v3 grounding master plan is explicit about its own sequencing principle (ADR-9): *"No enforcement milestone is allowed to depend on the full compiler/ClaimPlan build."* Phase 2 already shipped the enforcement milestone's remaining prerequisites (wiring outreach/alert-memo, the per-tenant rollout mechanism). Everything in **this** document is what the v3 plan calls "durable, built underneath" — real, valuable, still explicitly open work, but work that must not be allowed to gate Phase 2's rollout or balloon into an unbounded rewrite.

So this phase is organized into three tiers, not one flat list:

- **Tier 1 — closes real gaps in what Phase 2 assumes works.** Smallest, most urgent: without these, "enforce mode" is partly a no-op, and the checks the taxonomy still lacks stay lacking.
- **Tier 2 — the durable evidence-first architecture** (Waves 3–4's remainder). Real, valuable, needed before Phase 3 (Workspace citations) can lean on it — but explicitly *not* a blocker for Phase 2's enforcement rollout.
- **Tier 3 — convergence and infrastructure spikes** (Waves 6–7) that overlap with the original blueprint's own Phase 4 and are lower urgency; staged here for visibility, not committed to this phase's timeline.

**A correction to Phase 2, surfaced by this research:** Phase 2's exit criterion G3 ("at least one surface flipped to `enforce`") implicitly assumes that flipping the flag *does something*. It doesn't, yet, for chat — see §5 Tier 1, item 2.5-4. Phase 2's own new call sites for outreach/alert-memo (5.1A/5.1B) must be built to act on `verdict.decision` from day one; retrofitting that behavior onto the two *existing* chat call sites is this phase's job.

---

## 1. Current-state verification (code-verified 2026-07-12, cross-referenced against the v3 plan's own §4.1 checklist)

| Wave | Shipped | Still open (this phase's scope) |
|---|---|---|
| **Wave 0** — data contracts | RC1–RC9 fixes, `identifierKind`/`budgetExhibitType`, widened BLIN extraction, provision labeling, record-safe truncation, 23 mechanism evals. | PE↔procurement-line **join table + backfill** (real DB modeling, explicitly deferred as "own effort" in the plan's own text). |
| **Wave 1** — zero-tolerance prompt | `MERI_GROUNDING_INVARIANT` + surface blocks live byte-identical on all 5 surfaces; `validateFormBCitations`/`FORM_B_CITATION_RE`/`CitationAnchor` shipped as tested primitives. | **Wiring** `validateFormBCitations` to strip invalid tokens from *live* output, and normalizing FORM A/B into `CitationAnchor` on the response path — explicitly deferred to Wave 2 in the plan's own text, and Wave 2 shipped without picking it up. Also: source-row-cap tuning, per-surface model/config pinning. |
| **Wave 2** — post-hoc auditor | 8 of ~11 checks (D1, D4-text, D4-evidence, D4b, D6, D7, D9, D11); shadow hooks on chat/research/GA-chat; skeptic *mechanism* built (`skeptic.ts`, 9 tests, DI-shaped). | **D3 (numeric/unit), D5 (entity existence), D8 (primary-vehicle/sibling) checks** — distinct from Phase 2's blueprint-named D12/D13/D14, these are the *original* v3-taxonomy gaps. **Skeptic's real LLM judge** — the interface and fail-closed adjudication logic exist; no actual model call is wired in, so residual/undecidable findings today have nowhere to go. **Enforce-handling** — confirmed by direct code read: `meri.service.ts` and `chat-assistant.service.ts` both compute and log/persist `verdict.decision`, but **neither branches on it** — flipping `MERI_AUDITOR_MODE=enforce` today changes nothing about what the user receives on either chat surface. Only research's "Unverified" banner (`meri-research.service.ts:660-671`) is real enforce-handling. |
| **Wave 3** — EvidencePacket compiler | Slice A: `EvidencePacket`/`PlannedClaim`/`ClaimPlan`/`ArtifactDependency` contracts, `hashEvidenceContent`, 2 compiler adapters (`compilePeFundingEvidence`, `compileBillStatusEvidence`), 10-predicate registry. | **More compiler adapters** (votes, members/districts, report language, client facts, public-web passages). **The DB/dependency-graph slice**: `meri_evidence_version` + `meri_artifact_dependency` (2 RLS tables), invalidation events on ingestion, JIT dependency validation on send/publish/finalize, backfill of active scheduled outreach + pending alerts. **G0 architecture-boundary test** (model-facing code may not import low-level truth records or serialize bare authoritative fields). |
| **Wave 4** — pre-synthesis ClaimPlan gate | Gate core shipped (`claim-gate.ts`, judges `PlannedClaim`s vs. `EvidencePacket`s, 10 tests, pure). | **ClaimPlan proposal** (code-gen for templated/alert surfaces; schema-forced model-proposed for research/outreach). **Constrained renderer** (approved claims + allowed spans only). **Post-render semantic diff**. **JIT freshness in the release verdict**, wired per surface. Chat intentionally stays post-hoc (not a gap — a standing design decision, ADR-2/ADR-9). |
| **Wave 5** — continuous audit/observability | `meri_audit_ledger` table + RLS + writer; legacy chat + research persist findings. | **Full ledger columns** (packets/claims/dependencies/anchors/repair diffs/latency/cost) + clean-turn sampling for a finding-rate denominator. **Golden fixtures** `golden-s1-hr8800-outreach`/`golden-s2-boresight-pe-chat`/`golden-s3-boresight-research` + counterfactual/stale-version variants (distinct from the incident-class assertions the current `auditor-golden.spec.ts` already has). **Adjudication queue** distilling every escape/false-positive into a fixture. **CloudWatch `Meri/Grounding` metrics + paging**. **Reviewer UI** (claim → evidence → source version → recommendation lineage). |
| **Wave 6** — generation-path convergence | Not started. | Route both chat loops through the shared kernel; parity fixtures (tools, memory, citations, streaming, artifacts); migrate to one kernel; deprecate legacy after parity + rollback criteria; delete hand-synced copies. **Overlaps directly with the original blueprint gap-analysis's own Phase 4** ("Finish the legacy→MeriV2 chat migration for all tenants") — flagged, not duplicated (§4). |
| **Wave 7** — NVIDIA ingestion benchmark | Not started. | Stratified hard-page benchmark (150–300 gold pages) vs. current parser; adopt only if accuracy/provenance/regression/throughput/cost gates pass. Explicitly "∥ any time after Wave 0" per the plan's own text — an opportunistic spike, not a dependency of anything else here. |
| **Release gates** | G1 (mechanism evals, blocking every PR) — confirmed live, 23+ evals. | G2 (golden, before every prod roll + nightly) and G3 (core suite, nightly + model/prompt PRs) exist as test files but are **not confirmed wired into CI as blocking, scheduled gates** — needs verification, not just test existence. G0/G4/G5 arrive with Waves 3/4/7 above, by the plan's own design (not before). |

---

## 2. Objective

Complete the v3 plan's own explicitly-marked remaining work (every `[ ]` in its §4.1), without violating its own sequencing principle (ADR-9: durable architecture is built underneath and must not gate enforcement). Concretely: close the "enforce mode is a no-op on chat" gap immediately; round out the deterministic-check taxonomy and wire the skeptic so residual/undecidable findings have somewhere to go; then, at a slower pace and lower priority, build the durable evidence/dependency-graph and pre-synthesis pipeline that Phase 3 (Workspace citations) will need to lean on.

---

## 3. Decisions needed before/at kickoff (Ninja)

| # | Decision | Recommendation | Why |
|---|---|---|---|
| D1 | **Tier 1 timing relative to Phase 2's enforce flip (5.1E).** | **Tier 1 (specifically 2.5-4, enforce-handling) ships *before* or *alongside* Phase 2's first enforce flip, not after.** | Phase 2's own exit gate (G3: "at least one surface flipped to enforce") is not meaningfully true for chat until enforce-handling exists; for outreach/alert-memo, build it into the new call sites directly rather than retrofitting later. |
| D2 | **How much of Tier 2 (Wave 3/4 durable architecture) to commit to in this phase vs. push to Phase 4.** | **Commit to the DB/dependency-graph slice (2.5-6) and the remaining compiler adapters actually needed by Phase 3's Workspace citations work (2.5-5) — defer the full ClaimPlan pipeline (2.5-8) to Phase 4**, since chat stays post-hoc by design and only deliverables (memo/outreach/research) need it, and Phase 2 already gives outreach/alert-memo working post-hoc protection. | Matches ADR-9's own sequencing logic: post-hoc enforcement is "good enough" protection while the plan-then-prose pipeline is built at a measured pace. |
| D3 | **Wave 6 (generation-path convergence) — plan it here, or defer entirely to the original blueprint's own Phase 4?** | **Defer entirely — do not duplicate.** Note it here for completeness (§1, §4) but do not build a parallel workstream; the original blueprint gap-analysis plan already owns this exact item. | Avoids two documents claiming ownership of the same migration and producing conflicting sequencing. |
| D4 | **Wave 7 (NVIDIA benchmark) — schedule now or leave fully opportunistic?** | **Leave opportunistic** — no fixed date, run whenever a team member has a free cycle after Wave 0 (already true today); do not block this phase's exit gate on it. | It's explicitly a spike with a go/no-go gate, not a dependency of anything else in this phase. |
| D5 | **Release-gate CI wiring (G2/G3)** — verify-and-fix now, or treat as a separate small ops ticket? | **Verify now, fix as part of this phase (2.5-13)** — it's cheap to check and, if missing, cheap to add (a CI workflow step), and it directly de-risks every other workstream's rollout. | Low cost, meaningfully reduces risk of an untested prompt/model change reaching prod between now and Phase 4. |

---

## 4. Non-goals (explicitly deferred, not silently dropped)

- **Wave 6 (generation-path convergence)** — owned by the original blueprint gap-analysis plan's own Phase 4, per D3. Not built here.
- **The full Wave 4 ClaimPlan pipeline** (proposal + constrained renderer + post-render diff) for research/outreach/memo — per D2, deferred to Phase 4; Phase 2's post-hoc protection is the interim state, by design (ADR-9).
- **Chat pre-synthesis gating** — a standing decision (ADR-2), not a gap; chat stays post-hoc unless measurement later shows a post-hoc escape it can't catch.
- **Wave 7 NVIDIA adoption decision** — the benchmark can run opportunistically (D4), but adoption itself (if the benchmark passes) is a separate, later decision with its own gate.

---

## 5. Workstreams

### Tier 1 — Close real gaps in what Phase 2 assumes works

#### 2.5-1 — Wire real enforce-handling for both chat surfaces

**What:** `meri.service.ts` (legacy chat, `runAuditor` call ~line 1251) and `chat-assistant.service.ts`'s `auditReplyShadow()` (GA chat) both compute `verdict.decision` and only log/persist it — confirmed directly, neither branches on the value. Add the actual behavior the v3 plan's own fail-policy table (§3.6) specifies for `chat deliverable`/`raw factual chat`: on `repair`, attempt the ≤2-iteration repair budget or fall back to a grounded-subset response with explicit gaps; on `hold` (deliverable chat only), hold the artifact and return the grounded summary + gaps — **never a silent unaudited reply**, per the plan's own degraded-mode language.

**Files:** `apps/api/src/meri/meri.service.ts` (chat turn handler, post-`runAuditor`), `apps/meriv2-orchestrator/src/meri/chat/chat-assistant.service.ts` (`auditReplyShadow`, likely needs to become blocking rather than fire-and-forget when `mode==='enforce'`).

**Success criteria:**
- [ ] 2.5-1.1 A `hold`/`repair` decision under `enforce` mode measurably changes what the user receives on both chat surfaces (verified by a test, not just a log line).
- [ ] 2.5-1.2 `shadow`/`annotate`/`off` behavior is provably unchanged (regression tests).
- [ ] 2.5-1.3 Phase 2's G3 ("at least one surface flipped to enforce") can be re-verified as *meaningful*, not just flag-flipped, once this ships.

#### 2.5-2 — Round out the deterministic check taxonomy: D3, D5, D8

**What:** three checks named in the v3 plan's own original design (§3.2) that were never built: **D3** (numeric equality + units — magnitude-safe comparison, distinct from D4's direction check), **D5** (entity existence — does a named bill/PE/person/committee actually exist in the ledger, catching pure fabrication that D1's citation check alone might miss), **D8** (primary-vehicle/sibling check — the mechanism `validatePrimaryVehicleClaim` already implements in isolation; the auditor becomes its executor, per the plan's own §3.1 reuse ledger).

**Files:** `packages/meriv2-core/src/grounding/auditor.ts` (three new check functions), `auditor.spec.ts` + `auditor-golden.spec.ts`.

**Success criteria:**
- [ ] 2.5-2.1 D3/D5/D8 implemented as pure functions, registered in `runAuditor`.
- [ ] 2.5-2.2 Each has a golden-fixture test; D8 specifically reuses `validatePrimaryVehicleClaim` rather than reimplementing its logic (per the plan's reuse-ledger intent).
- [ ] 2.5-2.3 The auditor now implements all of D1–D11 (11 of 11), plus Phase 2's D12–D14 — the full combined taxonomy.

#### 2.5-3 — Wire the skeptic's real LLM judge and route residuals to it

**What:** `skeptic.ts`'s `runSkeptic`/`runSkepticPanel` are built (adversarial-by-construction, fail-closed, DI-shaped for an injected `SkepticJudge`) but nothing implements a real `SkepticJudge` backed by an actual model call. Wire one (schema-forced, closed-world "REFUTE this" framing per the plan's own design), and route the auditor's `needs_skeptic`/undecidable findings to it — today those residuals simply pass through unadjudicated.

**Files:** new `SkepticJudge` implementation (likely `packages/meriv2-core/src/grounding/skeptic-judge.ts` or similar), wiring into `runAuditor`'s call sites (chat/research/outreach/alert once 5.1A/5.1B ship).

**Success criteria:**
- [ ] 2.5-3.1 A real model-backed `SkepticJudge` exists and is fail-closed (a malformed/throwing response = refuted, per the existing design).
- [ ] 2.5-3.2 At least one golden fixture exercises a genuinely undecidable claim (not covered by D1–D14) and confirms the skeptic catches it — this is the last `it.todo` in the golden suite per the v3 plan's own status.
- [ ] 2.5-3.3 Latency/cost of the added model call is measured before it's made blocking anywhere (per the plan's own "cost/latency numbers are placeholders until shadow-measured" caveat).

#### 2.5-4 — Finish Wave 1's deferred citation-stripping wiring

**What:** `validateFormBCitations` exists and is tested as a pure primitive, but is not wired to strip invalid tokens from *live* output on any surface, and FORM A/B are not yet normalized into `CitationAnchor` on the response path. The v3 plan itself deferred this to Wave 2 "since the auditor's `ToolResultLedger` is the correct place to validate against" — that ledger now exists (2.5-2/5.1A/5.1B use it), so this is unblocked.

**Files:** wherever each surface finalizes its reply/draft/report (the same call sites as 2.5-1/5.1A/5.1B), `meri-citations.helpers.ts`.

**Success criteria:**
- [ ] 2.5-4.1 An invalid FORM-B token is stripped from delivered output (not just flagged in shadow logs) on at least one surface, without a regression to legitimately-used tokens.
- [ ] 2.5-4.2 FORM A/B normalize into one `CitationAnchor` shape on the response path, per ADR-5.

#### 2.5-5 — Verify and, if needed, wire release gates G2/G3 into CI

**What:** per D5, confirm whether `auditor-golden.spec.ts` (G2) and the core grounding suite (G3) actually run as blocking gates "before every prod roll + nightly" and "nightly + model/prompt PRs" respectively, or whether they merely exist as test files exercised only by the standard PR test run. If the former isn't true, add the missing CI wiring (a scheduled workflow + a pre-deploy gate step).

**Files:** `.github/workflows/*` (whichever workflow(s) run tests today), possibly a new nightly workflow.

**Success criteria:**
- [ ] 2.5-5.1 Confirmed (not assumed) whether G2/G3 are real blocking/scheduled gates today.
- [ ] 2.5-5.2 If missing, both are wired: G2 blocks a prod deploy on golden-suite failure; G3 runs nightly and on any prompt/model-touching PR.

---

### Tier 2 — Durable evidence-first architecture (needed before Phase 3, not before Phase 2's rollout)

#### 2.5-6 — DB / dependency-graph slice (ADR-4)

**What:** the two RLS-scoped tables the v3 plan specifies (§3.4): `meri_evidence_version` (evidence_id, source_type/record_id, source_version/content_hash, effective_at/captured_at, supersedes_evidence_id) and `meri_artifact_dependency` (artifact_id, claim_id, evidence_id, source_version/content_hash, load_bearing/validated_at/invalidated_at) — following the `clio_memory`/`meri_audit_ledger` RLS pattern exactly. Plus: invalidation events fired when a bill status, vote, funding stage, member mapping, report-language link, or client record changes; JIT dependency validation immediately before send/publish/finalize; backfill for active scheduled outreach + pending alerts.

**Files:** new migration(s) (careful sequencing against the drift-prone dev DB, per the established gotcha), a new dependency-graph service, hooks into each ingestion job that can invalidate a dependency.

**Success criteria:**
- [ ] 2.5-6.1 Both tables exist with RLS, following the established pattern; migration clone-tested per the Phase 1 discipline.
- [ ] 2.5-6.2 A source update (e.g. a bill going `rule_failed`) demonstrably marks at least one dependent artifact stale.
- [ ] 2.5-6.3 A release-gate check blocks/regenerates a send when a load-bearing dependency's version has changed since drafting — the concrete mechanism that makes "freshness" a versioned-dependency property, not a clock property, per ADR-4.

#### 2.5-7 — Remaining EvidencePacket compiler adapters

**What:** votes, members/districts, report language, client facts, and public-web passages — each as a `compileXEvidence` adapter following the `compilePeFundingEvidence`/`compileBillStatusEvidence` pattern (Slice A). Prioritize members/districts first (it directly strengthens D11 and unblocks the `get_representation`/`resolve_entity` evidence path the auditor already partially relies on) and report language second (feeds D9's plus-up attribution).

**Files:** `packages/meriv2-core/src/grounding/evidence.ts` (new adapter functions), extending the `PREDICATE_REGISTRY`.

**Success criteria:**
- [ ] 2.5-7.1 At least the members/districts and report-language adapters ship; votes/client-facts/public-web may follow as later increments.
- [ ] 2.5-7.2 Each new adapter has predicate-coverage tests via `predicateCoverage()`, matching the existing two adapters' testing pattern.

#### 2.5-8 — G0 architecture-boundary test

**What:** a build-time (or CI-time) test asserting no model-client-facing code imports a low-level repository type or serializes an authoritative record without going through an approved compiler adapter — the structural enforcement of ADR-1 ("the truth layer is the only sanctioned path into a model").

**Files:** a new lint rule or dependency-boundary test (e.g. `dependency-cruiser`-style or a custom AST check), CI wiring.

**Success criteria:**
- [ ] 2.5-8.1 The test fails on a deliberately-introduced violation (a raw Prisma row passed to a prompt-building function) and passes on current code.
- [ ] 2.5-8.2 Wired as a blocking CI check, not just a local script.

#### 2.5-9 — ClaimPlan pipeline (deferred per D2 — do not start until Ninja confirms priority against Phase 3)

**What:** the actual plan-then-prose pipeline for deliverables: code-generated ClaimPlans for templated/alert surfaces, schema-forced model-proposed ClaimPlans for research/outreach, a constrained renderer (approved claims + allowed spans only), a deterministic post-render semantic diff, and JIT freshness wired into the release verdict.

**Status:** scoped here for completeness per the user's ask ("incorporate anything not done"), but **held pending D2** — this is genuinely large (the v3 plan's own re-baselined estimate: multiple weeks) and should not silently absorb this phase's timebox. Recommend explicitly punting to Phase 4 unless Ninja decides Phase 3's Workspace citation work needs it sooner than that.

**Success criteria (if greenlit):**
- [ ] 2.5-9.1 At least one deliverable surface (recommend alert-memo, since it's already templated/code-gen-friendly) has a working plan→gate→render→diff pipeline end to end.
- [ ] 2.5-9.2 The gate core (`claim-gate.ts`, already shipped) is reused unmodified as the judging layer — this workstream builds what feeds it and what consumes its verdict, not a new gate.

---

### Tier 3 — Staged for visibility, not this phase's commitment

#### 2.5-10 — Wave 0 residual: PE↔procurement-line join table + backfill

**What:** a real DB link table connecting Program Elements to their procurement line items, replacing the current inference-based association. Explicitly deferred by the v3 plan itself as "out of proportion to this serializer batch."

**Success criteria:**
- [ ] 2.5-10.1 Scoped and estimated properly (it's real data modeling, not a quick add) before committing a timeline.

#### 2.5-11 — Wave 5 observability completion

**What:** full `meri_audit_ledger` columns (packets/claims/dependencies/anchors/repair diffs/latency/cost) + clean-turn sampling; the three named golden fixtures + counterfactual/stale-version variants; an adjudication queue; CloudWatch `Meri/Grounding` metrics + paging; a reviewer UI (claim → evidence → source version → recommendation lineage).

**Note:** the golden-fixture and adjudication-queue pieces have real near-term value (they're what makes Tier 1's shadow-tuning-before-enforce discipline rigorous rather than ad hoc) — Ninja may want to pull these into Tier 1's timeline rather than Tier 3's. Flagged as a sequencing question, not a fixed placement.

**Success criteria:**
- [ ] 2.5-11.1 At minimum, the three named golden fixtures + adjudication queue ship (highest near-term value); the full ledger-column expansion and reviewer UI can trail.

#### 2.5-12 — Wave 6: generation-path convergence

Per D3 — not built here. Cross-reference: the original blueprint gap-analysis plan's own Phase 4 ("Converge the two LLM-routing systems... Finish the legacy→MeriV2 chat migration for all tenants").

#### 2.5-13 — Wave 7: NVIDIA ingestion benchmark

Per D4 — opportunistic, no fixed date, run whenever capacity allows after Wave 0 (already satisfied).

---

## 6. Phase 2.5 exit gate — success criteria

**Tier 1 (required for this phase to be called done):**
- [ ] **G1.** `enforce` mode produces a measurably different chat response on both surfaces when the auditor holds/flags — no more silent no-op. *(2.5-1)*
- [ ] **G2.** The auditor implements the full original D1–D11 taxonomy (D3/D5/D8 added) plus Phase 2's D12–D14. *(2.5-2)*
- [ ] **G3.** The skeptic is wired to a real model and adjudicates at least the residual class the golden suite still marks `it.todo`. *(2.5-3)*
- [ ] **G4.** Invalid citation tokens are actually stripped from delivered output on at least one surface, not just flagged in shadow. *(2.5-4)*
- [ ] **G5.** G2/G3 release gates are confirmed (or newly made) real, blocking, scheduled CI checks. *(2.5-5)*

**Tier 2 (target for this phase, may spill into early Phase 3 by mutual agreement):**
- [ ] **G6.** The dependency-graph tables exist, RLS'd, with at least one demonstrated invalidation → stale-artifact flow. *(2.5-6)*
- [ ] **G7.** At least two new EvidencePacket adapters ship (members/districts, report language). *(2.5-7)*
- [ ] **G8.** G0's architecture-boundary test exists and is CI-enforced. *(2.5-8)*

**Tier 3:** tracked for visibility; no completion criteria attached to this phase.

---

## 7. Sequencing

| Weeks | Work | Depends on |
|---|---|---|
| 1 | D1–D5 sign-off. 2.5-1 (chat enforce-handling) — sequenced **before or alongside** Phase 2's first enforce flip (5.1E), per D1. | Phase 2's 5.1A/5.1B call sites should already build in decision-handling from day one — no dependency, just sequencing awareness. |
| 1–2 | 2.5-5 (verify/fix CI gates) — cheap, independent, do early so the rest of this phase and Phase 2's rollout both benefit. | — |
| 2–3 | 2.5-2 (D3/D5/D8 checks) — independent of everything else. | — |
| 3–4 | 2.5-4 (citation-stripping wiring) — needs the ledger, which already exists. | — |
| 3–5 | 2.5-3 (skeptic real-judge wiring) — the largest Tier-1 item; needs latency/cost measurement before going further. | — |
| 5–6 | 2.5-11's highest-value slice (golden fixtures + adjudication queue) — pulled forward per the note in that item, since it directly strengthens Phase 2's shadow-tuning discipline. | — |
| 6–10 | 2.5-6 (dependency-graph tables) — largest Tier-2 item, own migration/clone-rehearsal discipline per Phase 1's established pattern. | — |
| 8–12 | 2.5-7 (remaining adapters) + 2.5-8 (G0 test) — can run in parallel with 2.5-6. | — |
| — | 2.5-9 (ClaimPlan pipeline) — **held pending explicit Ninja go-ahead per D2**, not on the default timeline. | — |
| — | 2.5-10, 2.5-12, 2.5-13 — Tier 3, no committed timeline. | — |

---

## 8. Rollout mechanics (repo-specific, non-negotiable)

- Same `api-image.yml` path-gating gotcha as Phases 1/2 for any `packages/meriv2-core/**`-only change (most of this phase).
- **2.5-6's migrations** follow the Phase 1 discipline exactly: merge≈deploy, clone-rehearsed, canary tenant first, post-deploy check wired to alerting.
- **2.5-1 and 2.5-4 change what users actually receive** the moment `enforce` (or a stripped-citation mode) is live for a tenant — treat with the same canary discipline as Phase 2's 5.1E, even though the mechanism (per-tenant flag) already exists from that phase.

---

## 9. Rollback

| Workstream | Rollback |
|---|---|
| 2.5-1 (enforce-handling) | Revert the branch; falls back to the current log-only behavior (safe, if unsatisfying). |
| 2.5-2 (new checks) | Additive to `runAuditor`'s check list — remove to disable. |
| 2.5-3 (skeptic judge) | The `SkepticJudge` is DI-injected — swap back to no-op/unadjudicated residuals by not injecting a real judge. |
| 2.5-6 (dependency tables) | Same RLS-drop rollback pattern as Phase 1's 1C; no irreversible step. |

---

## 10. Testing & verification checklist

- Same typecheck/test/golden-fixture discipline as Phases 1 and 2.
- 2.5-1 specifically needs a test proving `enforce` mode changes the actual response payload, not just a log/ledger row — the exact class of gap this workstream exists to close.
- 2.5-6's migrations follow the clone-rehearsal + canary discipline established in Phase 1.

---

## 11. Risks specific to this phase

- **The enforce-handling gap (2.5-1) is a silent trust gap today** — anyone who believes flipping `MERI_AUDITOR_MODE=enforce` protects chat users is currently wrong. This should be communicated to Ninja plainly, independent of this plan's timeline, since it affects how "enforcement milestone" claims are represented internally.
- **Tier 2/3 scope is genuinely large** — if not held to the tiering in §3/§5, this phase could silently re-absorb the "cathedral before roof" risk ADR-9 was written to avoid. Keep Tier 1 strictly separate and shippable on its own.
- **2.5-9 (ClaimPlan pipeline) is the single largest item in this entire document** — do not start it without an explicit Ninja go-ahead per D2; it's sized more like its own phase than a workstream.
- **Wave 6 overlap risk (2.5-12/D3)** — if this document's Tier 3 placeholder is mistaken for ownership, work could duplicate the original blueprint plan's own Phase 4. The cross-reference in §4/§5 exists specifically to prevent that.
