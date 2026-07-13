# Phase 4 Deployment Plan — Finish the Moat, Converge the Runtime

**Source documents:**
- [`docs/plans/2026-07-12-capiro-strategic-blueprint-execution-plan.md`](2026-07-12-capiro-strategic-blueprint-execution-plan.md) — Phase 4 ("Finish the moat, converge the runtime, months 3–6").
- [`docs/plans/2026-07-12-capiro-phase-2-5-grounding-master-plan-completion.md`](2026-07-12-capiro-phase-2-5-grounding-master-plan-completion.md) — its Tier 3 item 2.5-12 (Wave 6 generation-path convergence) explicitly deferred here; this document is where that work actually lands.
- [`docs/plans/2026-07-12-capiro-phase-0-verification-checklist.md`](2026-07-12-capiro-phase-0-verification-checklist.md) — Item 3 (PE alert canary) is the *starting point* this phase's §5.2 finishes rolling out.

**Status:** PROPOSED — awaiting Ninja sign-off, in particular on §3's D2 (the LLM-gateway convergence is smaller than the source blueprint assumes — worth confirming scope before committing a timeline) and D4 (whether the legacy chat *rollout* question is actually still open, since code shows it may already be resolved).

---

## 0. Why this phase's premise needed re-checking before planning it

Two of this phase's four "still open" claims from the original gap-analysis plan turned out to be **partially stale** once checked against current code — worth surfacing plainly before committing a plan around them:

1. **"MeriV2 full-chat is live only for one tenant"** — not true today. Direct code read of `tenant-flags.ts:50-54`: *"GA (2026-07): the tenant flag defaults ON, so a tenant without an explicit flag is on MeriV2 whenever MERIV2_ENABLED is set — opt out with an explicit `false`."* Every tenant is on MeriV2 chat today unless it explicitly opted out, and only the global `MERIV2_ENABLED` kill-switch plus a rare per-tenant opt-out stand between "some" and "all" tenants. **The rollout is essentially done.** What genuinely remains is *code-level convergence* — the legacy `meri.service.ts` implementation still exists and still runs in parallel for any opted-out tenant, and nothing has deleted the hand-synced duplicate logic between the two loops (the v3 grounding master plan's own Wave 6, never started). This phase's runtime-convergence workstream is about **that**, not about getting more tenants onto MeriV2 — that part already happened.
2. **"Two independent LLM-routing systems"** — also not quite accurate. `apps/api`'s `AiCredentialResolverService` already resolves BOTH `openai` and `anthropic` credentials (tenant-key-first, then global fallback) and already forwards a resolved credential into the MeriV2 orchestrator over the request (`RequestScopedLlmClient`, explicitly commented "BYOK2"). **The gap is narrower than "build a second gateway"** — MeriV2's `LlmClient` interface is already provider-agnostic in shape; only its one concrete implementation (`AnthropicLlmClient`) is Anthropic-only, and the forwarding code never branches on which provider was actually resolved. Converging these is "add an `OpenAiLlmClient` and a branch," not "unify two independent systems."

Both corrections shrink this phase's actual scope relative to the original framing — worth pricing accordingly rather than planning against the more expensive original description.

---

## 1. Current-state verification (code-verified 2026-07-12)

| Area | State | Evidence |
|---|---|---|
| PE budget narrative timeline | **Does not exist as one assembled view.** The underlying pieces are individually strong — `DeltaEngineService` computes typed, materiality-scored deltas per PE/FY (`materialityScore`, `materialityFactors`) and has an affected-tenant fan-out (`getAffectedTenants`) — but nothing stitches request→marks→enactment into one narrative artifact per program element. | `delta-engine.service.ts:78-484`. |
| PE alert email rail | **Already running, not yet fully rolled out or user-controllable.** `send-pe-alert-emails.ts` runs on a live schedule and stamps watchlist relevance every run regardless of the canary; only the actual email send is gated by `PE_ALERT_EMAIL_TENANTS` (comma-separated UUIDs or `'all'`). No web UI exists for the per-user `pe_alert_email_pref` (`off`/`daily`/`daily_plus_critical`) — confirmed by grep, the field has a read path (`program-element-read.service.ts`) but zero web-side references. | Phase 0 checklist Item 3 (already-verified detail); `pe_alert_email_pref` grep, 1 backend hit, 0 web hits. |
| Appropriations-conference field | **Confirmed schema-reserved, genuinely unpopulated.** `schema.prisma:2894-2897`: *"Appropriations-track conference (Defense Appropriations conference / JES). RESERVED: no loader populates it yet... Kept NULL until a real appropriations-conference source lands."* Distinct from `ndaaConference` (authorization-track), which **is** populated and correctly kept off the appropriations ladder per Phase 2's RC1 fix. | `schema.prisma:2894-2901`. |
| Mark-impact "propose next actions" | **Confirmed absent.** No `proposeNextAction`/`nextAction` logic anywhere in `delta-engine.service.ts` — it computes and scores deltas but stops there. | Repo-wide grep, zero hits. |
| MeriV2 chat rollout | **Effectively complete** (see §0.1) — per-tenant flag defaults ON since the 2026-07 GA; gated only by the global `MERIV2_ENABLED` env var and rare explicit opt-outs. | `tenant-flags.ts:27-61`. |
| Generation-path convergence (code-level) | **Not started.** Two loops still run in production (`meri.service.ts` legacy chat, `chat-assistant.service.ts` GA orchestrator), independently implementing overlapping logic (confirmed in Phase 2 research: the firm/user-voice memory loader alone is independently reimplemented three times). This is the v3 grounding master plan's own Wave 6, explicitly deferred to "this phase" by Phase 2.5's D3. | Phase 2 research findings; v3 plan §Wave 6. |
| LLM-gateway convergence | **Narrower gap than assumed** (see §0.2). `AiCredentialResolverService` (`apps/api`) already resolves both providers; MeriV2's `LlmClient` interface (`packages/meriv2-core/src/llm/llm-client.ts:12-38`) is provider-agnostic by shape; only the one concrete class (`AnthropicLlmClient`) and the orchestrator's `RequestScopedLlmClient.resolve()` (which never reads a provider field off the forwarded credential) are Anthropic-only in practice. | `llm-client.ts:12-115`; `request-scoped-llm.client.ts:1-70`; `ai-credential-resolver.service.ts:22-167`. |
| Approval-risk model | **A real PASS/WARN/BLOCK rule engine exists** (`compliance-rules.ts`), but in practice only one outcome (`WARN`, "requires human approval") is used — the seed ruleset is deliberately a single catch-all pending Ninja's domain input on real BLOCK/PASS conditions. Not literally binary in the type system, but functionally close to it today. Phase 3 (Workspace) is independently building a Low/Moderate/High/Restricted risk-tier concept for document exports — a natural precedent for this phase's own 4-tier model, not a separate invention. | `compliance-rules.ts:44-65` (`DEFAULT_COMPLIANCE_RULES`, one catch-all WARN rule); [Phase 3 plan](2026-07-12-capiro-phase-3-workspace-trustworthy-deployment-plan.md) §5, workstream 3.2. |

---

## 2. Objective

Per the gap-analysis plan's own Phase 4 framing, corrected for what §0/§1 found: assemble the PE narrative timeline, finish the PE alert rollout (all tenants + a real user-facing toggle), populate the appropriations-conference field, extend the mark-impact engine to propose actions, widen MeriV2's LLM client to the multi-provider gateway that already exists one layer up, delete the legacy chat implementation now that the tenant rollout is functionally complete, and generalize the compliance engine's single-WARN-rule reality into the blueprint's real 4-tier model — reusing Phase 3's Workspace risk-tier work as the first implementation of that same taxonomy rather than building it twice.

---

## 3. Decisions needed before/at kickoff (Ninja)

| # | Decision | Recommendation | Why |
|---|---|---|---|
| D1 | **PE alert rollout target** — flip `PE_ALERT_EMAIL_TENANTS` to `'all'` directly, or roll tenant-by-tenant after `capiro-internal`'s canary window? | **Tenant-by-tenant**, using `capiro-internal`'s Phase 0 canary run as the first data point, then expand in batches. | This job already sends real client-facing email; a big-bang `'all'` flip skips the chance to catch a formatting/data issue before it reaches every tenant's inbox. |
| D2 | **LLM-gateway convergence scope** — given §0.2's finding that this is smaller than originally framed, confirm the narrower scope (add `OpenAiLlmClient` + branch in `RequestScopedLlmClient.resolve()`) rather than a bigger rebuild. | **Confirm the narrow scope.** Re-price this workstream at "small" now that the actual gap is understood, rather than carrying the original blueprint's larger estimate forward. | Avoids over-scoping/over-staffing a workstream that turned out to be mostly two new classes and a branch, not a rearchitecture. |
| D3 | **Legacy chat deprecation timing** — delete `meri.service.ts`'s independent chat-turn logic once parity fixtures pass, or keep it running indefinitely as a permanent opt-out path for any tenant that wants it? | **Delete after parity fixtures pass, on a real timeline** (per ADR-8's own sequencing: "consolidation is not a prerequisite for protecting users... first route both loops through shared safety primitives, THEN migrate to one kernel"). Keep a short, explicit rollback window, not an indefinite dual-maintenance state. | Every month both loops exist independently, the maintenance/fragmentation cost compounds — this is explicitly the risk the gap-analysis plan's own §7 named ("fragmentation compounds if Phase 1–2 slip"). |
| D4 | **4-tier risk model ownership** — build one taxonomy definition once (in `@capiro/shared` or `meriv2-core`), consumed by both Workspace's export gate (Phase 3) and MeriV2's compliance-rules engine, or let each own its own tiers? | **One shared taxonomy, two consumers.** Define Low/Moderate/High/Restricted once, with each consumer mapping its own artifact types (Workspace products; MeriV2 tool names) onto the shared four values. | Exactly the kind of "two parallel systems solving the same problem" pattern the blueprint calls out repeatedly — don't recreate it here. |
| D5 | **Appropriations-conference data source** — which real source populates the `conference` field (a specific committee-report parser, a manual entry path, or piggybacking on an existing ingestion job)? | Needs Neo's domain input on which source is authoritative and parseable — **not a decision this document should make unilaterally.** | This is a data-sourcing/ingestion-scope call, not an engineering-tradeoff call; flag it as a real open question rather than guess. |

---

## 4. Non-goals (explicitly deferred)

- **Any change to Workspace's own risk-tier gate mechanics** — Phase 3 owns that; this phase only ensures the *taxonomy* (Low/Moderate/High/Restricted) is defined once and shared, per D4.
- **New BLOCK/PASS compliance rules for specific tools** (the "lobbying/ethics/gift/pay-to-play" content `compliance-rules.ts` explicitly says needs Neo's domain input) — this phase builds the *mechanism* (4-tier model), not the specific rule content, which stays a domain decision for later.
- **A full historical backfill of the appropriations-conference field** for all past fiscal years — this phase populates it going forward once a source exists (D5); backfilling history is a separate, larger data-migration decision.
- **Any pricing/packaging change** — the gap-analysis plan's own §5 pricing tension is explicitly a business-track item, tracked separately, not folded into this engineering phase.

---

## 5. Workstreams

### 4.1 — PE budget narrative timeline

**What:** assemble a single "request → marks → enactment" view per program element, using `DeltaEngineService`'s already-computed, materiality-scored deltas as the data source — this is UX/assembly work over existing data, not new data modeling, per the gap-analysis plan's own characterization.

**Files:** new read endpoint aggregating `ProgramElementYear`/delta rows into a timeline shape, a new web component (likely alongside the existing `WhatChangedPanel.tsx`).

**Success criteria:**
- [ ] 4.1.1 A single PE's full FY timeline (request, each committee mark, conference, enacted) renders as one coherent narrative, correctly labeling each stage per the existing `FUNDING_CURRENT_PRECEDENCE` ladder (never coalescing stages, per Phase 2's RC1 fix — reuse `renderPeFundingForModel`'s labeling discipline for the human-facing UI too, not just the LLM-facing one).
- [ ] 4.1.2 The view surfaces `materialityScore`/`materialityFactors` inline, not as a separate lookup.

### 4.2 — PE alert rail: full rollout + user-facing toggle

**What:** per D1, expand `PE_ALERT_EMAIL_TENANTS` beyond the `capiro-internal` canary in batches; separately, build the missing web UI for `pe_alert_email_pref` (off/daily/daily_plus_critical) — today a real, working preference field with zero way for a user to actually set it.

**Files:** `send-pe-alert-emails.ts` env rollout (ops, no code), a new settings UI component + read/write endpoint for the preference.

**Success criteria:**
- [ ] 4.2.1 A defined batch schedule for tenant rollout exists and is followed (not a silent big-bang flip).
- [ ] 4.2.2 A user can see and change their own `pe_alert_email_pref` in the product; the value takes effect on the next scheduled run.

### 4.3 — Populate the appropriations-conference field

**What:** per D5 (pending Neo's source decision), wire whichever source is chosen into the existing `conference` column's write path, following the same versioned/provenance-preserving pattern as every other budget field in this system (never overwrite history; new version + reviewer identity, per blueprint §8.5).

**Success criteria:**
- [ ] 4.3.1 New defense-appropriations conference reports populate `conference` going forward (not backfilled, per non-goals).
- [ ] 4.3.2 The field's presence unblocks any UI/reasoning currently working around its NULL-ness (e.g., 4.1's narrative timeline can now show a real appropriations-conference stage instead of a gap).

### 4.4 — Mark-impact engine: propose next actions

**What:** extend `DeltaEngineService`'s output — today it explains *what* changed and *how much it matters* (materiality score) — to also propose a concrete next action (e.g., "draft outreach to committee X," "flag to client Y's team") per blueprint Table 37's "Mark impact engine" capability description. Reuse Phase 2's action-recommendation infrastructure (`action-recommendation.service.ts`, already confirmed to exist and compute `relevanceScore` elsewhere in this codebase) rather than building a second recommendation engine.

**Files:** `delta-engine.service.ts` (new proposal step, or a new consuming service that reads its output), reuse of `action-recommendation.service.ts` patterns.

**Success criteria:**
- [ ] 4.4.1 A materially significant delta (per the existing scorer's threshold) produces at least one concrete, actionable recommendation, not just a description of the change.
- [ ] 4.4.2 Reuses the existing action-recommendation data shape/service rather than introducing a parallel one.

### 4.5 — LLM-gateway convergence (narrow scope, per D2)

**What:** per §0.2's finding, this is genuinely small. Add an `OpenAiLlmClient implements LlmClient` in `packages/meriv2-core/src/llm/`, mirroring `AnthropicLlmClient`'s shape. In `RequestScopedLlmClient.resolve()` (`request-scoped-llm.client.ts`), read the `provider` field already present on the forwarded credential (`RequestCredentialsStore.get()?.aiProvider`) and construct the matching client class instead of always assuming Anthropic. No changes needed to `AiCredentialResolverService` itself — it already resolves both providers correctly; this workstream only teaches the *consumer* to respect what it already receives.

**Files:** `packages/meriv2-core/src/llm/llm-client.ts` (new `OpenAiLlmClient`), `apps/meriv2-orchestrator/src/meri/request-scoped-llm.client.ts` (`resolve()` branch on provider).

**Success criteria:**
- [ ] 4.5.1 A tenant with an OpenAI BYOK credential and no Anthropic credential can successfully complete a MeriV2 chat turn (today this would fail — `RequestScopedLlmClient` only ever builds an Anthropic client).
- [ ] 4.5.2 Existing Anthropic-only tenants see zero behavior change.
- [ ] 4.5.3 `completeJson`/`completeWithSchema` both work correctly through the new OpenAI implementation (schema-forcing may need a different mechanism than Anthropic's tool-forcing trick — confirm OpenAI's equivalent, e.g. structured outputs/JSON mode, before assuming parity).

### 4.6 — Generation-path convergence (Wave 6, picked up from Phase 2.5's deferral)

**What:** per D3 and ADR-8's own sequencing ("first route both loops through the shared prompt/auditor/citation transport — already done via Phase 2's work — THEN migrate to one kernel"). Build parity fixtures (tools, memory, citations, streaming, artifacts, verification metadata) comparing legacy chat and GA-orchestrator-chat behavior turn-for-turn; once parity + rollback criteria are met, migrate any remaining opted-out tenants, then delete `meri.service.ts`'s independent turn-handling logic and the hand-synced duplicate copies this phase's own research found (the firm/user-voice memory loader alone was independently reimplemented three times — Phase 2's 5.2A-1 already consolidated that specific one; this workstream is the broader sweep for whatever else remains duplicated).

**Files:** new parity-fixture test suite, `apps/api/src/meri/meri.service.ts` (deletion, once parity holds), any remaining hand-synced constants/logic between the two surfaces.

**Success criteria:**
- [ ] 4.6.1 A parity-fixture suite exists and passes, covering tools/memory/citations/streaming/artifacts/verification metadata for both loops before any deletion happens.
- [ ] 4.6.2 `meri.service.ts`'s independent chat-turn implementation is deleted (not just deprecated-but-present) once parity holds and a defined rollback window has passed.
- [ ] 4.6.3 A grep for hand-synced duplicate logic between the two surfaces (the class of bug Phase 2 found with the firm/voice loader) returns nothing new.

### 4.7 — 4-tier approval-risk model (generalizes Phase 3's Workspace tiers)

**What:** per D4, define Low/Moderate/High/Restricted once (shared location — `@capiro/shared` or `meriv2-core`), matching blueprint Table 10's control requirements per tier. Map MeriV2's existing tool names onto these four tiers (today's single `WARN` catch-all becomes the *default* for tools without a more specific rule, not the only possible outcome). Reuse Phase 3's Workspace product-type tier mapping as the second consumer of the same shared enum, rather than each system inventing its own.

**Files:** new shared risk-tier module, `compliance-rules.ts` (extend `DEFAULT_COMPLIANCE_RULES` with tier-aware entries, pending Neo's actual rule content per non-goals), cross-reference into Phase 3's `WsDraft.riskTier` field to confirm it uses the same enum values.

**Success criteria:**
- [ ] 4.7.1 One shared Low/Moderate/High/Restricted definition exists; Workspace's `riskTier` (Phase 3) and MeriV2's tool-risk classification both reference it, not two separately-typed enums that happen to have similar names.
- [ ] 4.7.2 The compliance-rules engine's fallback behavior is unchanged in practice for tools without a specific rule (still WARN by default) — this workstream adds the *taxonomy*, not new blocking behavior, unless Neo separately provides real rule content.

---

## 6. Sequencing

Given this phase spans months 3–6 per the original blueprint framing, and its workstreams are largely independent of each other:

| Phase | Work | Depends on |
|---|---|---|
| Early | D1–D5 sign-off. 4.5 (LLM-gateway, now confirmed small) and 4.2's rollout batching (D1) can both start immediately — independent of everything else. | — |
| Early–mid | 4.1 (PE narrative timeline) + 4.4 (mark-impact next-actions) — both pure assembly over existing data, can run in parallel. | — |
| Mid | 4.7 (4-tier model) — sequence after Phase 3's Workspace tier work has shipped, so this workstream extends a working precedent rather than defining the taxonomy in a vacuum. | Phase 3 workstream 3.2. |
| Mid–late | 4.6 (generation-path convergence) — the largest, highest-risk item; needs its own parity-fixture build-out before any deletion. | Phase 2's shared-prompt/auditor work (already done). |
| Ongoing, lower priority | 4.3 (appropriations-conference) — blocked on D5's data-source decision; can proceed whenever that's resolved, doesn't block anything else in this phase. | D5. |

---

## 7. Rollout mechanics (repo-specific, non-negotiable)

- **4.2's rollout** uses the exact same out-of-band task-def env-var mechanism as Phase 0's canary flip — no code deploy needed to expand the tenant list.
- **4.5's new `OpenAiLlmClient`** lives in `packages/meriv2-core` — same `api-image.yml` path-gating gotcha as every prior phase's `meriv2-core`-only change (needs a forced `workflow_dispatch` rebuild, or it silently won't ship).
- **4.6's deletion step** is the highest-consequence single action in this phase — treat it with the same canary/rollback discipline as any RLS change in Phase 1: confirm parity fixtures pass for `capiro-internal` first, keep the legacy code revertible (branch, not force-deleted history) for a defined window before final cleanup.
- **Do not `cdk deploy` the Compute stack** for any of this — same standing prohibition as every other phase in this repo, ship via `scripts/deploy-dev.sh` and out-of-band task-def revisions.

---

## 8. Rollback

| Workstream | Rollback |
|---|---|
| 4.1/4.4 (assembly/read-only features) | Revert the branch; no data implications, these are pure read/UI layers over existing tables. |
| 4.2 (rollout) | Set `PE_ALERT_EMAIL_TENANTS` back to the prior (smaller) tenant list — instant, no redeploy. |
| 4.5 (LLM gateway) | The new client is additive; `resolve()`'s branch can default back to always-Anthropic with a one-line change if the OpenAI path misbehaves. |
| 4.6 (convergence) | Keep `meri.service.ts` on a revertible branch for the defined rollback window (D3) before any hard deletion — this is the one workstream where "rollback" must be a real, tested path, not just "revert the commit," since tenants may be actively depending on the legacy loop until parity is proven. |
| 4.7 (risk model) | Additive enum + mapping; remove the mapping to fall back to today's undifferentiated behavior. |

---

## 9. Testing & verification checklist

- Standard typecheck/test discipline across `apps/api`, `packages/meriv2-core`, `apps/workspace` (for 4.7's cross-reference into Phase 3).
- 4.5 specifically needs a real end-to-end test against an OpenAI-only tenant credential, not just a unit test of the new class in isolation.
- 4.6's parity-fixture suite is itself the primary test artifact for this phase — it must be built and reviewed before the deletion step, not written after the fact to justify a decision already made.

---

## 10. Phase 4 exit gate — success criteria

- [ ] **G1.** A PE's full budget narrative (request→marks→enactment) renders as one coherent, correctly-labeled view.
- [ ] **G2.** The PE alert email rail has expanded past the `capiro-internal` canary per a real rollout schedule, and a user-facing preference toggle exists.
- [ ] **G3.** The appropriations-conference field is being populated going forward from whichever source Neo confirms (D5) — or, if D5 is still unresolved, this is explicitly carried forward rather than silently dropped.
- [ ] **G4.** The mark-impact engine proposes at least one concrete next action per materially significant delta, reusing existing action-recommendation infrastructure.
- [ ] **G5.** MeriV2 chat works correctly for an OpenAI-only BYOK tenant, with zero behavior change for Anthropic-only tenants.
- [ ] **G6.** A parity-fixture suite exists and passes; `meri.service.ts`'s independent implementation is deleted (not merely deprecated) once the defined rollback window has passed.
- [ ] **G7.** One shared 4-tier risk taxonomy is defined and consumed by both Workspace (Phase 3) and MeriV2's compliance engine.

---

## 11. Metrics to instrument (blueprint Table 51, scoped to this phase)

- **PE alert rollout coverage**: tenants receiving live emails / total active tenants — track toward 100% (or whatever ceiling D1's batching plan settles on).
- **Generation-path convergence**: 2 loops → 1, tracked as a binary milestone once 4.6's deletion ships.
- **LLM-provider parity**: whether an OpenAI-only tenant can complete a MeriV2 chat turn — 0/1 today, target 1.
- **Mark-impact action-proposal rate**: % of materially significant deltas that produce a concrete recommendation, 0% today.

---

## 12. Risks specific to this phase

- **4.6 is the highest-risk single workstream across every phase planned so far** — deleting a production chat implementation that (per §0.1) most tenants have already silently migrated off of, but that some opted-out tenants may still depend on. Treat the parity-fixture suite as non-negotiable before any deletion, and keep a real (not just git-history) rollback path for the defined window.
- **D5 (appropriations-conference source) is a genuine unknown** — this document correctly refuses to guess a data source, but that means 4.3 has no committed timeline until Neo weighs in; don't let it silently block anything else in this phase (it's sequenced as non-blocking in §6 for exactly this reason).
- **4.5's OpenAI schema-forcing mechanism may not be a drop-in equivalent** to Anthropic's tool-forcing trick (`completeWithSchema`) — confirm OpenAI's actual structured-output guarantee before assuming full parity, rather than discovering a silent quality gap after rollout.
- **4.7 risks recreating the exact fragmentation problem it exists to solve** if Workspace and MeriV2 don't actually converge on one shared enum — verify this concretely (not just "both call it Low/Moderate/High/Restricted" but literally the same TypeScript type from one shared package).
