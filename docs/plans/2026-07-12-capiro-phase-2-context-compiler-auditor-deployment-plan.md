# Phase 2 Deployment Plan — Context Compiler v1 + Auditor Enforcement

**Source documents:**
- `Capiro_Strategic_Product_and_Growth_Blueprint_v2.docx` — §4.1–4.3 (shared runtime), §4.4 (hard validators, Table 15), §4.6.4/§4.6.6 (shared context contract, context compilation layers), Table 13/17/20, §12.5 gates, Appendix C.
- [`docs/plans/2026-07-12-capiro-strategic-blueprint-execution-plan.md`](2026-07-12-capiro-strategic-blueprint-execution-plan.md) — Phase 2 ("Context Compiler v1 + auditor enforcement, weeks 4–10").
- [`docs/plans/2026-07-12-meri-zero-trust-grounding-master-plan-v3.md`](2026-07-12-meri-zero-trust-grounding-master-plan-v3.md) — the authoritative, already-in-flight technical plan for the auditor/evidence half of this phase (15 PRs shipped as of today, 2026-07-12).
- [`docs/plans/2026-07-12-capiro-phase-1-memory-ledger-deployment-plan.md`](2026-07-12-capiro-phase-1-memory-ledger-deployment-plan.md) — Phase 1, whose canonical `memory_items` ledger this phase's Context Compiler reads from.

**Status:** PROPOSED — awaiting Ninja sign-off on §3 before branch work starts.

---

## 0. Why this is two workstreams wearing one name

The gap-analysis plan's Phase 2 bundles two genuinely different subsystems under one heading:

- **(A) Context Compiler** — assembling *approved input context* for generation (client strategy, firm identity, relevant history, current evidence, exclusions — blueprint §4.6.6). This is about what goes **into** a prompt.
- **(B) Auditor enforcement** — verifying *generated output* against evidence after the fact (blueprint §4.4, Table 15). This is about what happens **after** a prompt runs.

They're bundled because both target the same three surfaces (chat, outreach, alert-memo) and both close the "surface divergence" gap (blueprint Table 17). But their current build status is wildly different, and conflating them would misprice this phase:

- **(B) is ~80% done.** A separate, already-in-flight effort (the v3 grounding master plan, 15 PRs merged today) built a deterministic auditor with 8 checks, live in shadow on chat/research/GA-chat, plus an EvidencePacket compiler (Slice A) with 2 adapters and a 10-predicate registry. What's left for *this* phase is narrow: wire the two missing surfaces, add the checks the blueprint specifically names, and manage the shadow→enforce cutover.
- **(A) barely exists as a shared thing.** Outreach has a rich, 20+-channel context assembly — but it's not a module, it's inline logic embedded in a 2,000+-line method, untyped, and rendered by an outreach-specific formatter. Chat's context model is architecturally different (pull via tool calls, not push via pre-assembly) — and that difference is *correct*, not a bug to erase.

§1 below is the precise current-state accounting; §5 scopes each workstream to what's actually left, not what the blueprint's generic prose implies.

---

## 1. Current-state verification (code-verified 2026-07-12)

| Area | State | Evidence |
|---|---|---|
| Deterministic auditor (D1–D11 design) | **8 of ~11 checks shipped**: D1 (citation existence), D4-text + D4-evidence (numeric direction, incl. implicit reversal via compiled evidence), D4b (auth/approp conflation), D6 (failed-rule operative framing), D7 (LI-as-PE), D9 (plus-up misattribution), D11 (member↔district). Missing: D3 (numeric/unit), D5 (entity existence), D8 (primary-vehicle/sibling), D10 (freshness/JIT). | `packages/meriv2-core/src/grounding/auditor.ts`; v3 plan §4.1 Wave 2. |
| Auditor shadow coverage | Live (env-gated, default off) on **legacy chat** (`meri.service.ts:1248`, persists to `meri_audit_ledger`) and **research** (`meri-research.service.ts:631`, persists + prepends "Unverified" banner under annotate/enforce). **GA-orchestrator chat** also runs the auditor (`chat-assistant.service.ts:252`) but is **log-only — findings never reach `meri_audit_ledger`**, only CloudWatch. **Outreach and alert-memo have zero call sites.** | Confirmed directly + by background research agent; v3 plan §4.1 line 799 ("Log-only here") and line 801 ("Remaining: shadow on the outreach + alert loops; persist GA-chat findings"). |
| Auditor gate's surface-awareness | The `decisionFor()` gate (`auditor.ts:556-570`) **already** hardcodes `outreach`/`alert`/`research` as fully-blocking (`hold` on any finding under `enforce`) — even though no real call site produces those surface tags today. Only `auditor.spec.ts`/`auditor-golden.spec.ts` exercise them. | Direct read, confirmed by background agent. |
| Auditor rollout mechanism | **A single global `process.env.MERI_AUDITOR_MODE`**, read identically and independently at all three call sites. **No per-tenant override exists** — no `tenant-flags.ts` entry, no `settings_jsonb.clioFeatureFlags` key, despite two prior plan docs *mentioning* a "per-tenant `auditor.enforce`" as aspirational. `apps/api/scripts/set-tenant-flag.ts` could write such a key today, but nothing reads it. | `apps/api/src/common/tenant-flags.ts` (the actual pattern, used by `outreachClientProfileEnabled` etc.) has no auditor entry — confirmed by background agent. |
| EvidencePacket compiler (Wave 3) | **Slice A shipped**: `EvidencePacket`/`PlannedClaim`/`ClaimPlan`/`ArtifactDependency` contracts, `compilePeFundingEvidence` + `compileBillStatusEvidence` (2 adapters), a 10-predicate registry. **Not shipped**: adapters for votes/members/districts/report-language/client-facts/public-web; the 2 RLS dependency tables + invalidation events + JIT freshness check; the G0 architecture-boundary test. | v3 plan §4.1 Wave 3; `packages/meriv2-core/src/grounding/evidence.ts`. |
| Pre-synthesis ClaimPlan gate (Wave 4) | **Gate core shipped** (`claim-gate.ts`, judges claims vs. evidence packets), but the ClaimPlan *proposal* step, the constrained renderer, and the post-render diff — the actual "plan-then-prose" pipeline — do not exist yet. | v3 plan §4.1 Wave 4. |
| Outreach context assembly | **Rich but split across TWO divergent, untyped gathering paths — one with a known unfixed bug.** (1) The batch/campaign path, `EngagementService.generateBatchEmails` (`engagement.service.ts:2392-2881`), inline-calls ~15 distinct private helpers (`loadUserVoiceBlock`, `outreachTrackedBillsBlock`, `outreachClientWatchlistBlock`, `outreachClientPeopleBlock`, etc.) and assembles a flat `context: Record<string, unknown>` bag (`OutreachPromptV2Input`, `prompt-spec-v2.ts:346-359`) via ~20 named channels (`HANDLED_CONTEXT_KEYS`, `prompt-spec-v2.ts:300-327`), rendered through `nonEmptyStr()` (`prompt-spec-v2.ts:156-163`) — **object-valued channels silently drop**; this hit prod once already (`clientContext`, fixed ad hoc in PR #405 by pre-rendering to a string at `engagement.service.ts:2476-2488`, not by fixing the renderer). (2) The **separate single-record path**, `generateOutreachDraft` (`engagement.service.ts:1571-1680`), calls an entirely different, smaller helper `outreachContext()` (`engagement.service.ts:5599-5644`) that gathers a different channel set (notes, debriefs, meetings, directory matches) and **still assigns `clientContext` as a raw object with no string-rendering fix** (`engagement.service.ts:5639`) — the same silent-drop bug the batch path fixed in PR #405 is, by code shape, still live on this second path. Neither path is a callable, shared module — gathering logic is inline and mixed with outreach-specific concerns in both. Separately, the firm-Soul/Compass + user-voice memory-file loader is **independently reimplemented three times** with near-identical raw SQL: legacy chat's `loadUserVoiceContext` (`meri.service.ts:2841-2916`), MeriV2's `MeriContextResolver.loadFirmMemory/loadUserVoice` (`meri-context.resolver.ts:48-97`, whose own comment says it "mirrors" the legacy one), and outreach's `loadUserVoiceBlock` (`engagement.service.ts:1487-1560`). One channel, `EngagementService.clientContext()` (`engagement.service.ts:4736`), is genuinely already shared — called from legacy chat's `get_client_context` tool, MeriV2's HTTP-delegated equivalent, and outreach — proving the "shared gatherer" pattern already works here for at least one channel. | Direct reads + background research agent, cross-verified: `engagement.service.ts:1571-1680, 2392-2881, 4736, 5599-5644`, `prompt-spec-v2.ts:156-163, 300-327, 346-359`; `project_outreach_context_builder` memory. |
| Chat context assembly | **Two different shapes, both thinner than outreach by design.** Legacy chat has ONE identifiable per-turn function, `orchestrateContext()` (`meri.service.ts:2040-2380`): unconditional firm/user-voice load + a client-KB snapshot or plain fallback + `clio_memory` recall, plus four intent-gated tool calls (only fire for classified intents). **MeriV2 GA chat has no context-orchestration function at all** — it's a bounded tool-calling loop (`chat-assistant.service.ts` `run()`); the only pre-loaded context is `firmMemory`/`userVoice` (via the triplicated loader above) and a `memoryContext` string that is not computed by the orchestrator itself but **forwarded over HTTP from legacy chat's own `loadRelevantMemories()`** when a turn routes to MeriV2 (`meri.service.ts:1496-1523`) — a working-but-inelegant stopgap, not a shared module. Neither chat surface gets outreach's 20+ pre-assembled channels, and correctly so — eagerly pushing that volume into every turn would regress latency/cost for no benefit; the model calling tools on demand is the right model for chat. | Direct reads + background research agent: `meri.service.ts:2040-2380, 2841-2916, 1496-1523`; `chat-assistant.service.ts` `run()`; `chat-prompt.ts:165-245`; `meri-context.resolver.ts:20-97`. |
| Alert-memo context/grounding | **Its own bespoke, independent grounding pattern** — not connected to the Context Compiler question at all today. `AlertMemoService.generate()` builds a numbered "claim sheet" (`buildClaims(alert)`) from `AlertMemoAlertInput` — a payload passed in from the frontend Feed with **no live status field**, only frozen fields (`billDisplayNum`, `title`, `whyItMatters`, etc.). The LLM (direct Anthropic `fetch`, `alert-memo.service.ts:217`) may assert only claims from that sheet (`verifyGrounded`); on failure or ungrounded output it **already falls back to a deterministic `scaffold()`** — i.e., the "degraded mode" the v3 plan calls for on this surface already exists. What's missing is that the claim sheet itself is never re-verified against live `get_bill_status`/`get_pe_budget_timeline` data — this is RC3 from the v3 audit, confirmed concretely: no code path in `alert-memo.service.ts` calls either tool. | Direct reads of `alert-memo.service.ts:1-120, 253-262`, `alert-memo.types.ts:1-30`. |
| Shared context contract across surfaces | **Does not exist.** Chat, outreach, and alert-memo each independently decide what evidence/context to use, in three different shapes (pull-via-tools / push-via-untyped-bag / frozen-claim-sheet), with no common inclusion/exclusion trace log. | Synthesis of the three rows above. Directly answers blueprint Table 17's "Surface divergence" row. |

---

## 2. Objective

> Blueprint Table 13: *"Chat, Artifact Studio, outreach, alerts, meetings, and reporting must use the same context contract. Different subsets may be allowed by task, risk, and permission, but no surface should maintain an independent version of Meri's memory."*
> Blueprint Table 15 (validators still missing a deterministic check): enactment proof, legislative chronology, negative assertions.
> Appendix C: *"Do chat, documents, outreach, alerts, meetings, and reporting all use the same context contract?"*

Gap-analysis plan's own Phase 2 gate: **"At least chat + outreach + alert-memo consume the same context contract and log the same inclusion/exclusion trace metadata."** This document targets exactly that gate — not the full Wave 3/4 evidence-graph build-out, which belongs to Phase 4.

---

## 3. Decisions needed before/at kickoff (Ninja)

| # | Decision | Recommendation | Why |
|---|---|---|---|
| D1 | **What "same context contract" means.** A literal single shared renderer, or a shared *gatherer* with surface-specific renderers? | **Shared gatherer, distinct renderers.** Extract outreach's reusable channels (client relationship snapshot, bill/PE truth, tracked bills, firm/client memory) into a shared module that returns *structured* data + a manifest; each surface keeps its own thin formatting layer (outreach's JSON email contract, chat's tool results, alert-memo's claim sheet). | Consistency should mean *same data source, same freshness rules, same exclusion logic* — not *same delivery mechanism*. Forcing chat to eagerly load outreach's full channel set would regress latency/cost for no benefit; chat's pull-based design is correct as-is. |
| D2 | **Auditor rollout mechanism** before enforcing on outreach (which *blocks sends*, per the gate's own hardcoded `blocking` set). | **Build a per-tenant override** — a `tenant-flags.ts` entry following the exact `outreachClientProfileEnabled` pattern (`settings_jsonb.clioFeatureFlags`), read *in addition to* the global env var, before any surface flips to `enforce`. | Today one global env var governs all wired surfaces for 100% of tenants simultaneously — there is no way to canary. Outreach `enforce` = a blocked client send; that blast radius is much larger than chat's shadow logging and needs a real rollback lever, not a redeploy. |
| D3 | **Which new checks to prioritize** — blueprint names enactment-proof, legislative-stage-ordering, negative-assertion/coverage; the existing plan separately still owes D3/D5/D8/D10. | Build **D10 (freshness/JIT-lite)** and a **new enactment-proof check** together first (both require a structured public-law-ID + date before certain claims can be made) — see §5.2C. Treat legislative-stage-ordering and negative-assertion as **new deterministic checks that formalize prompt guidance already shipped** (the `<procedure>`/`<absence>` blocks in the Wave-1 prompt) rather than net-new domain research — the gap is turning existing prose guidance into a checkable rule, not inventing new domain knowledge. | Reuses shipped domain knowledge; avoids re-deriving semantics that already exist in the prompt. |
| D4 | **Enforce order across surfaces.** | **Outreach + alert-memo first, then research, then chat** — matches both the v3 plan's own sequencing and the gap-analysis plan's explicit call. | These are the two surfaces the original incidents shipped from and the two still unwired — highest leverage, and outreach/alert already have a safe degraded-mode fallback (hold / scaffold) to land on. |
| D5 | **Alert-memo's frozen-snapshot fix (RC3).** Build a bespoke re-query, or reuse Wave 3's `compileBillStatusEvidence`/`compilePeFundingEvidence` adapters? | **Reuse.** These adapters already exist and are exactly evidence-typed; alert-memo's claim sheet should be built (partly) from their output instead of trusting `AlertMemoAlertInput`'s frozen fields. This is also what supplies the *real* ledger entries the auditor needs to check alert-memo output against something other than itself. | Building a second bill/PE-truth compiler would directly recreate the fragmentation problem this whole plan exists to close. |
| D6 | **Scope of the "context contract"** for Phase 2 — the full Wave 3 DB/dependency-graph (2 RLS tables, invalidation events, JIT validation on every send) or a lighter version? | **Lighter version for Phase 2**: structured evidence + an inclusion/exclusion trace log, without the full versioned-dependency invalidation machinery. | The Phase 2 gate only requires 3 surfaces on one contract with trace metadata — the full freshness-invalidation infrastructure is Phase 4 territory (per the gap-analysis plan) and would blow this phase's timebox. |

---

## 4. Non-goals (explicitly deferred)

- **Workspace** onto the Context Compiler — blueprint's own "eventually," gap-analysis's own Phase 3.
- **Full pre-synthesis ClaimPlan pipeline** (Wave 4: ClaimPlan proposal, constrained renderer, post-render diff) for outreach/research/memo — the gate core is reused (§5.2C references it), but building the full plan-then-prose pipeline is Wave 4/Phase 4 work, not required for this phase's gate.
- **The full versioned-dependency graph** (2 RLS tables, invalidation events on every ingestion job, JIT validation on send/publish/finalize) — per D6, scoped down for this phase.
- **Remaining EvidencePacket adapters** (votes, members/districts, report language, client facts, public-web passages) beyond what §5.1 needs for alert-memo — added incrementally in Phase 4 as surfaces demand them.
- **Chat's pre-synthesis gating** — chat stays post-hoc per ADR-2/ADR-9; revisit only if measurement shows a post-hoc escape it can't catch.

---

## 5. Workstreams

> **⚠️ Correction surfaced during Phase 2.5 research (see [`2026-07-12-capiro-phase-2-5-grounding-master-plan-completion.md`](2026-07-12-capiro-phase-2-5-grounding-master-plan-completion.md) §1/§5-1):** neither existing chat call site (`meri.service.ts`, `chat-assistant.service.ts`) actually branches on `verdict.decision` today — both only log/persist it. Flipping `MERI_AUDITOR_MODE=enforce` is currently a no-op on chat. **5.1A and 5.1B below must build real decision-handling (hold/repair, not just persistence) into their new call sites from day one** — do not repeat chat's gap. Retrofitting the two existing chat call sites is Phase 2.5's job (workstream 2.5-1), sequenced before or alongside this phase's 5.1E enforce flip so that G3 below is actually true, not just flag-true.

### 5.1 Auditor enforcement (extends the in-flight v3 plan; do not duplicate it)

#### 5.1A — Wire the auditor onto outreach

**What:** in `AlertMemoService`-style fashion but for outreach's `generateBatchEmails`/`draftOutreach` path — after a draft is generated, build a `ToolResultLedger` (`{entries: [{tool, serialized, result?, rowCount?}]}` — a trivially simple shape, confirmed from `auditor.ts:54-68`) from whatever evidence actually fed the draft (bill/PE truth blocks, tracked bills), call `runAuditor({output, ledger, surface: 'outreach', mode})`, and persist to `meri_audit_ledger` exactly as legacy chat/research already do (`prisma.withTenant(...).meriAuditLedger.create(...)`, best-effort try/catch, never blocking the draft in shadow mode). **Under `enforce`, this call site must actually act on `verdict.decision === 'hold'` (block the send, surface the reviewer skeleton) — not just persist it (see the correction above).**

**Files:** `engagement.service.ts` (or wherever the draft-generation call site lives), new `outreach-ledger.helpers.ts` to build the ledger from existing context channels, reuse of `meri_audit_ledger` persistence pattern from `meri.service.ts:1263-1282`.

**Success criteria:**
- [ ] 5.1A.1 A generated outreach draft is audited in `shadow` mode; findings persist to `meri_audit_ledger` with `surface='outreach'`.
- [ ] 5.1A.2 Shadow mode never alters or delays a draft (try/caught, fire-and-forget, matching the existing pattern).
- [ ] 5.1A.3 At least the D1/D4/D4b/D6/D7/D9/D11 checks that are meaningful for outreach's bill/PE-truth content actually fire on a known-bad fixture (reuse the golden incident fixtures from the v3 plan, e.g. the H.R. 8800 ICBM reversal case).

#### 5.1B — Wire the auditor onto alert-memo (bundled with the RC3 fix, §5.2C)

**What:** same mechanism as 5.1A, but alert-memo's ledger entries must come from **live** evidence, not just the claim sheet echoing itself — see §5.2C for why this must ship together with the frozen-snapshot fix. Build the ledger from the `compileBillStatusEvidence`/`compilePeFundingEvidence` outputs used to refresh the claim sheet, tagged as if from `get_bill_status`/`get_pe_budget_timeline` (matching what the auditor's D1/D6 checks expect to see).

**Files:** `alert-memo.service.ts` (`generate()`, around the `buildClaims`/`callAnthropic` calls), same `meri_audit_ledger` persistence pattern.

**Success criteria:**
- [ ] 5.1B.1 A generated alert memo is audited in `shadow` mode against live-refreshed evidence, findings persist with `surface='alert'`.
- [ ] 5.1B.2 D6 (failed-rule operative framing) fires correctly on a memo drafted from an alert whose underlying bill has since gone to `rule_failed`.
- [ ] 5.1B.3 The existing `scaffold()` degraded-mode fallback is confirmed still reachable and unaffected (no regression to the one safety net this surface already has).

#### 5.1C — Persist GA-orchestrator chat's shadow findings

**What:** `chat-assistant.service.ts`'s `auditReplyShadow()` (line 252) currently only logs to CloudWatch — the highest-traffic chat surface's tuning data is invisible to the same `meri_audit_ledger` queries used to decide the enforce flip for every other surface. Add the same `prisma.withTenant(...).meriAuditLedger.create(...)` call already used by legacy chat and research.

**Files:** `apps/meriv2-orchestrator/src/meri/chat/chat-assistant.service.ts:241-267`.

**Success criteria:**
- [ ] 5.1C.1 GA-chat shadow findings persist to `meri_audit_ledger` with `surface='chat'`, queryable the same way as legacy-chat/research findings.

#### 5.1D — Three new deterministic checks

Per D3:

- **D12 — Enactment proof.** A claim using the label "enacted" (or equivalent) must be backed by a ledger entry carrying a structured public-law identifier + enactment date (mirrors blueprint Table 15's validator exactly). Where the underlying tool payload lacks these fields, flag it — this also motivates completing the "enacted" field structurally in the budget-timeline payload if it isn't already carrying one (verify against `get_pe_budget_timeline`'s existing `enacted` field shape before building the check — it may already exist and just needs a stricter consumer-side gate).
- **D13 — Legislative stage-ordering / chronology.** Formalizes the already-shipped `<procedure>` prompt block into a deterministic check: a claim asserting a later procedural stage (conference, passage, enactment) must not appear without the ledger evidencing the required prior stage. Reuses the same stage-ladder constants the auditor's D4b already imports.
- **D14 — Negative-assertion / coverage check.** Formalizes the shipped `<absence>` prompt block: a claim of the form "no hearings scheduled," "no mark recorded," "all committees," etc. must be backed by a ledger entry demonstrating the query actually covered the full relevant set (not silence from a narrow query). This is also the deterministic half of what the v3 plan's `ZeroResultSynthesisRate` metric measures — today that's tracked as a metric but not gated as a hard check; D14 makes it one.

**Files:** `packages/meriv2-core/src/grounding/auditor.ts` (three new check functions + registration in `runAuditor`), `auditor.spec.ts` + `auditor-golden.spec.ts` (extend with fixtures).

**Success criteria:**
- [ ] 5.1D.1 D12/D13/D14 implemented as pure functions over `(output, ledger)`, following the exact shape of the existing 8 checks.
- [ ] 5.1D.2 Each has at least one golden-fixture test proving it catches its named failure mode and does not false-positive on a correct equivalent.
- [ ] 5.1D.3 Registered in `runAuditor`'s check list; dedupe logic (`(check, span)`) extended to cover them.

#### 5.1E — Per-tenant rollout mechanism + shadow→enforce cutover

**What:** per D2, add a `tenant-flags.ts` entry (e.g. `auditorSurfacePolicy` or reuse the existing pattern with a per-surface key) read *alongside* `MERI_AUDITOR_MODE`, so a single tenant/surface pair can be moved to `enforce` while everything else stays `shadow`. Sequence per D4: outreach + alert-memo first (once 5.1A/5.1B have accumulated a real shadow-observation window and findings have been tuned against the golden fixtures + adjudicated live samples — do not flip on day one of wiring), then research (already shadow-only, needs its own tuning window), then chat.

**Files:** `apps/api/src/common/tenant-flags.ts` (new entry, following `outreachClientProfileEnabled`'s exact shape), the four call sites (add the per-tenant check before falling back to the global env var).

**Success criteria:**
- [ ] 5.1E.1 A single tenant can be flipped to `enforce` on outreach while every other tenant stays `shadow`, verified by reading two tenants' behavior side-by-side.
- [ ] 5.1E.2 Outreach and alert-memo have accumulated and been tuned against at least one full shadow-observation window (per-check finding rate reviewed, false-positive rate acceptable) before either flips to `enforce` for any tenant.
- [ ] 5.1E.3 `capiro-internal` is the first tenant flipped to `enforce` on each surface (canary pattern, consistent with every other rollout on this repo).

---

### 5.2 Context Compiler v1

#### 5.2A-0 — Immediate fix: the unfixed silent-drop bug on the single-record path

**What:** `outreachContext()` (`engagement.service.ts:5599-5644`) assigns `clientContext` as a raw object at line 5639 with no string-rendering step — the exact bug PR #405 fixed on the batch path (`generateBatchEmails`), left unfixed here. Apply the same `renderClientRelationshipSnapshot()` treatment used at `engagement.service.ts:2476-2488`. This is a same-day, near-zero-risk fix — ship it independently of the rest of §5.2, before the larger extraction work, since it's a live latent bug, not a design gap.

**Success criteria:**
- [ ] 5.2A-0.1 Confirm whether `generateOutreachDraft`/`outreachContext()` is reachable with `workflow: 'campaign'` and `OUTREACH_PROMPT_SPEC=v2` in any live tenant (the background research flagged this as unconfirmed) — if reachable, this is an active prod bug, not a theoretical one.
- [ ] 5.2A-0.2 `clientContext` renders as a string on this path exactly as it does on the batch path; regression test added so the two paths can't diverge on this again silently.

#### 5.2A-1 — Consolidate the triplicated firm/user-voice memory loader

**What:** the lowest-risk, highest-clarity win in this workstream. Three independent, near-identical raw-SQL implementations of "load firm Soul/Compass + user voice" exist today — `meri.service.ts`'s `loadUserVoiceContext`, MeriV2's `MeriContextResolver.loadFirmMemory/loadUserVoice` (whose own comment admits it mirrors the legacy one), and outreach's `loadUserVoiceBlock` (which additionally pulls a client-people memory type the other two don't). Extract ONE shared function (return structured data: `{soul, compass, userVoice, clientPeople?}`), used by all three call sites. This is a direct, concrete instance of the blueprint's named "parallel fragmented systems" pattern, and — unlike the full 20-channel extraction below — is low-risk: it's the same query logic, called from three places, not a redesign.

**Files:** new shared function (e.g. `packages/meriv2-core/src/context/firm-voice-loader.ts` or `@capiro/shared`), `meri.service.ts`, `meri-context.resolver.ts`, `engagement.service.ts` (all three call sites repointed).

**Success criteria:**
- [ ] 5.2A-1.1 One implementation, three callers; the two duplicate raw-SQL copies are deleted, not left dormant.
- [ ] 5.2A-1.2 Outreach's superset behavior (client-people memory type) is preserved via a parameter/flag, not lost in the consolidation.
- [ ] 5.2A-1.3 Zero output regression on all three surfaces (fixture-based comparison).

#### 5.2A-2 — Extract outreach's remaining context-gathering into a shared, structured module

**What:** pull the remaining reusable channels (client relationship snapshot — already shared via `EngagementService.clientContext()`, the one existing proof this pattern works; bill/PE truth; tracked bills/watchlist; action recs; upcoming hearings; member press) out of **both** divergent gathering paths (`generateBatchEmails`'s ~15 inline helpers and `outreachContext()`'s smaller set) into one new shared module — a plain function per channel, each returning **structured data**, not a pre-rendered string, plus a per-channel `{included: boolean, reason?: string, freshness?: string}` entry for the trace log (blueprint Table 20's "Exclusions and trace"). Leave outreach-specific concerns (budget gating, template resolution, recipient dedup, JSON email contract) where they are. Reconciling the two divergent paths onto one shared source is itself part of the fix — do not extract from `generateBatchEmails` alone and leave `outreachContext()` as a third, still-divergent implementation.

**Files:** new module (e.g. `apps/api/src/context-compiler/` or `packages/meriv2-core/src/context/`), `engagement.service.ts` (replace inline fetching in **both** `generateBatchEmails` and `outreachContext()` with calls into the new module), `prompt-spec-v2.ts` (consumes structured data directly instead of the untyped `context: Record<string, unknown>` bag — this also durably fixes the "object channels silently drop" gotcha at its root, rather than the current per-channel pre-render-to-string workaround).

**Success criteria:**
- [ ] 5.2A-2.1 Every channel currently gathered inline in `generateBatchEmails` **and** `outreachContext()` is now sourced from the shared module; both call sites shrink correspondingly, and no longer diverge on which channels/fixes each has.
- [ ] 5.2A-2.2 No object-valued channel can silently drop — the new module returns typed data, and the renderer either handles a channel's actual shape or the type system prevents omission.
- [ ] 5.2A-2.3 A trace log (inclusion/exclusion + reason + freshness) is produced per generation and is inspectable (log line or persisted row — decide alongside 5.2D).
- [ ] 5.2A-2.4 Zero output regression: a byte-for-byte (or semantically equivalent) diff against pre-refactor drafts on a fixture set, for both the batch and single-record paths.

#### 5.2B — Expose the same channels to chat as tool implementations

**What:** per D1, do **not** push outreach's channel set into chat's context window. Instead, where chat already has a tool that fetches similar data ad hoc (e.g. client relationship info), repoint it to call the *same* shared gatherer function from 5.2A-1/5.2A-2, so both surfaces read from one source with one freshness/exclusion policy — achieving data parity without changing chat's pull-based delivery model. Where chat has no equivalent tool yet for a channel outreach has (e.g. a client relationship snapshot), add a thin tool wrapper around the shared function. Also repoint MeriV2's `memoryContext` from its current HTTP-forwarding stopgap (`meri.service.ts:1496-1523`) onto the new shared function directly, retiring that round-trip.

**Files:** relevant MeriV2 tool definitions (`packages/meriv2-core/src/tools/`), legacy `meri-tools.service.ts` for parity.

**Success criteria:**
- [ ] 5.2B.1 At least the client-relationship-snapshot and bill/PE-truth channels are available to chat via a tool that calls the same underlying function outreach uses — not a reimplementation.
- [ ] 5.2B.2 Chat's latency/token profile is unchanged for turns that don't invoke the new tools (confirming no eager pre-loading was introduced).

#### 5.2C — Fix alert-memo's frozen-snapshot (RC3) using the shared evidence adapters

**What:** in `AlertMemoService.generate()`, before `buildClaims(alert)`, re-derive the bill/PE status claims from **live** data using the already-shipped `compileBillStatusEvidence`/`compilePeFundingEvidence` adapters (Wave 3 Slice A) rather than trusting `AlertMemoAlertInput`'s frozen fields. This closes RC3 for this surface (the v3 plan's own §3.6 fail-policy table already names "Auditor + draft-time `get_bill_status` re-query" for alert-memo) and, per D5, supplies the real ledger entries 5.1B's auditor wiring needs to be meaningful rather than circular.

**Files:** `alert-memo.service.ts` (`generate()`, `buildClaims()`), reuse of `compileBillStatusEvidence`/`compilePeFundingEvidence` from `packages/meriv2-core/src/grounding/evidence.ts`.

**Success criteria:**
- [ ] 5.2C.1 A memo drafted for a bill that has changed status since the alert was computed (e.g. a rule that has since failed) reflects the **current** status, not the frozen Feed snapshot.
- [ ] 5.2C.2 The existing `scaffold()` fallback still triggers correctly if live re-query fails (network/API error) — the fix adds a re-query, it does not remove the safety net.
- [ ] 5.2C.3 5.1B's auditor wiring, run against this surface post-fix, checks generated prose against genuinely live evidence (verified by a test: a stale claim is flagged even when it matches the original frozen input).

#### 5.2D — Shared trace-metadata log

**What:** a minimal, consistent record of what was included/excluded and why, emitted by all three surfaces' context-assembly step (blueprint Table 20's "Exclusions and trace"). Given the DB dependency-graph is deferred (D6), this can be a structured log line (not a new table) for Phase 2 — e.g. reuse `meri_audit_ledger`'s adjacent logging infra or a lightweight new log shape — sufficient to prove the gate (§6) without building Wave 3's full infrastructure.

**Success criteria:**
- [ ] 5.2D.1 Chat, outreach, and alert-memo each emit a trace record per generation with the same field shape (channel name, included/excluded, reason, source, freshness where known).
- [ ] 5.2D.2 A reviewer can answer "what did this specific draft use, and what did it deliberately exclude?" from the trace record alone, for at least one real example per surface.

---

## 6. Phase 2 exit gate — success criteria

**All of the following must be true before Phase 2 is declared shipped:**

- [ ] **G1.** Outreach and alert-memo both run the deterministic auditor in at least `shadow` mode, persisting findings to `meri_audit_ledger` with the correct `surface` tag — the two surfaces the original incidents shipped from are no longer unmonitored. *(5.1A, 5.1B)*
- [ ] **G2.** GA-orchestrator chat's shadow findings persist to `meri_audit_ledger`, not just CloudWatch — shadow-tuning data from the highest-traffic surface is no longer invisible to the same queries used to decide every other surface's enforce flip. *(5.1C)*
- [ ] **G3.** At least one surface (outreach or alert-memo, per D4) has been flipped to `enforce` for at least one tenant (`capiro-internal`), after a real shadow-observation + tuning window — not on the same day it was wired — **and that flip is verified to actually change behavior** (a held draft is genuinely blocked, not merely logged as `decision='hold'`). *(5.1A/5.1B's decision-handling + 5.1E; see the Phase 2.5 correction above)*
- [ ] **G4.** Three new deterministic checks (enactment-proof, stage-ordering, negative-assertion coverage) are shipped and golden-fixture-tested. *(5.1D)*
- [ ] **G5.** Chat, outreach, and alert-memo all source at least the client-relationship and bill/PE-truth channels from **one shared gatherer module**, not three independent implementations — including the firm/user-voice loader (5.2A-1) and the two divergent outreach paths reconciled onto one source (5.2A-2). *(5.2A-1, 5.2A-2, 5.2B)*
- [ ] **G6.** Alert-memo no longer trusts a frozen Feed snapshot for bill/PE status — it re-derives from live evidence before drafting. *(5.2C)*
- [ ] **G7.** All three surfaces emit a trace record (inclusion/exclusion + reason) in the same shape, inspectable per generation. *(5.2D)*
- [ ] **G8.** A per-tenant auditor rollout mechanism exists and is in use — no surface was flipped to `enforce` via the bare global env var alone. *(5.1E, D2)*
- [ ] **G9.** Zero regressions: outreach draft quality/latency and chat turn latency are unchanged for the common case (measured against a pre-Phase-2 baseline).

*Directly answers Appendix C: "Do chat, documents, outreach, alerts, meetings, and reporting all use the same context contract?" — for the three in-scope surfaces, yes; Workspace/meetings/reporting remain Phase 3+.*

---

## 7. Sequencing

| Weeks | Work | Depends on |
|---|---|---|
| 1 | D1–D6 sign-off. 5.1C (persist GA-chat findings) + 5.2A-0 (fix the unfixed `outreachContext()` object-drop bug) — both small, independent, ship immediately. | — |
| 1–2 | 5.2A-1 (consolidate the triplicated firm/user-voice loader) — low-risk, do this before the larger extraction so 5.2A-2 builds on one loader, not three. | — |
| 2–4 | 5.2A-2 (extract + reconcile outreach's two divergent gatherers into one shared module) — the largest single piece; do this before wiring new consumers onto old inline logic. | 5.2A-1. |
| 4–5 | 5.2C (alert-memo live re-query, reusing Wave 3 adapters) + 5.1B (alert-memo auditor wiring) — **ship together**, per D5 (the auditor needs live evidence to be meaningful here). | 5.2A-2's adapters are reused, not blocking; 5.2C can start once Wave 3's existing adapters are confirmed sufficient. |
| 5–6 | 5.1A (outreach auditor wiring) — now that 5.2A-2's structured channels exist, building the ledger from them is straightforward. | 5.2A-2. |
| 5–6 | 5.1D (three new checks) — can run in parallel with the above; independent of context-compiler work. | — |
| 6–7 | 5.2B (expose shared channels to chat as tools, retire the `memoryContext` HTTP-forwarding stopgap) + 5.2D (trace log across all three surfaces). | 5.2A-1, 5.2A-2. |
| 7–9 | 5.1E — shadow-observation window, tuning against golden fixtures + adjudicated live samples, then the first per-tenant enforce flip (outreach or alert-memo, `capiro-internal` first). | 5.1A/5.1B/5.1C/5.1D all shipped and observed for at least one real traffic window. |
| 9–10 | Exit-gate review with Ninja; buffer for tuning iteration if the shadow data shows an unacceptable false-positive rate. | All of the above. |

---

## 8. Rollout mechanics (repo-specific, non-negotiable)

- **`api-image.yml` path-gating**: same gotcha as Phase 1 — `packages/meriv2-core/**` changes (5.1D's new checks, 5.2B's tool wrappers) need `gh workflow run api-image.yml -f env=dev --ref main` to force a rebuild; verify `:latest` carries the merge SHA.
- **No migrations required for this phase** — `meri_audit_ledger` already exists (Wave 5, shipped); the trace log (5.2D) is scoped to avoid a new table (D6). If a later decision reintroduces a table, follow the merge≈deploy discipline from Phase 1.
- **Canary tenant:** `capiro-internal` first for every enforce flip, per the established pattern and D4/5.1E.
- **Shadow-observation discipline:** per the v3 plan's own repeated warning, do not flip any surface to `enforce` without first reviewing accumulated `meri_audit_ledger` findings for that surface — an uncalibrated flip on outreach means blocking real client sends on an untuned lexicon.

---

## 9. Rollback

| Workstream | Rollback |
|---|---|
| 5.1A/5.1B/5.1C (shadow wiring) | Set `MERI_AUDITOR_MODE=off` (or the new per-tenant flag) — zero code rollback needed; shadow mode never alters output by construction. |
| 5.1D (new checks) | Checks are additive pure functions in `runAuditor`'s list — remove from the list to disable without touching the ledger/gate. |
| 5.1E (enforce flip) | Flip the per-tenant flag back to `shadow` — instant, no redeploy, which is exactly why D2's per-tenant mechanism is a prerequisite, not a nice-to-have. |
| 5.2A-0 (bug fix) | Revert the branch; `outreachContext()` returns to the unfixed raw-object assignment (not recommended — this reintroduces a known live bug). |
| 5.2A-1/5.2A-2 (shared gatherer) | Revert the branch; the three call sites return to their independent implementations. Additive extraction, no data migration involved. |
| 5.2C (alert-memo re-query) | Revert to trusting `AlertMemoAlertInput`'s frozen fields; the `scaffold()` fallback is unaffected either way. |

---

## 10. Testing & verification checklist

- `pnpm --filter @capiro/api typecheck` + `pnpm --filter @capiro/meriv2-core typecheck` → 0 new errors.
- `pnpm --filter @capiro/api test` + meriv2-core test suite → green, plus new suites for 5.1D's checks and 5.2A-1/5.2A-2's extracted gatherer.
- Golden-fixture suite (`auditor-golden.spec.ts`) extended to cover D12/D13/D14 without regressing the existing 6-incident-class coverage.
- A real-traffic shadow-observation window (length TBD with Ninja, likely 1–2 weeks) reviewed via `SELECT surface, top_severity, decision, findings_jsonb FROM meri_audit_ledger` before any enforce flip.
- Manual demo: draft an outreach email referencing a bill that has since gone `rule_failed` → confirm the auditor (shadow) flags it, and (once enforced) the send is held with the reviewer skeleton shown, not silently sent.

---

## 11. Metrics to instrument (blueprint Table 51, scoped to this phase)

- **Surface context parity**: 0/4 → target 2–3/4 (chat, outreach, alert-memo on the shared gatherer; Workspace remains Phase 3).
- **Auditor coverage × enforcement**: checks live (8→11) × surfaces wired (3→5, counting GA-chat persistence as "wired") × at least one surface in `enforce` for at least one tenant (0→1).
- **ZeroResultSynthesisRate** (already defined in the v3 plan): becomes gated by D14, not just measured.
- **Citation/finding rate trend** on outreach and alert-memo during the shadow window — the concrete number that justifies (or delays) the enforce flip.

---

## 12. Risks specific to this phase

- **A known-shape bug may already be live**: `outreachContext()` (the single-record path) never received the object→string rendering fix `generateBatchEmails` got in PR #405 — if that path is reachable in production with `workflow: 'campaign'` + `OUTREACH_PROMPT_SPEC=v2`, client-relationship context is silently dropping from single-record drafts right now. Confirm reachability (5.2A-0.1) before anything else in this phase — this is a live-bug check, not a design decision.
- **Flipping `enforce` on an uncalibrated surface is the single highest-risk action in this phase** — the gate already hard-codes `hold` for outreach/alert/research on *any* finding; an untuned lexicon could block a real percentage of legitimate client sends. Mitigated by D2 (per-tenant mechanism) + 5.1E's explicit "observe before flip" gate.
- **5.2A-2 is a real refactor of two production methods** (`generateBatchEmails` at 2,000+ lines, plus the smaller but divergent `outreachContext()`), not a mechanical extraction — regression risk on outreach's actual draft quality is non-trivial, and reconciling two already-divergent implementations is riskier than extracting from one. Mitigate with the fixture-based diff check in 5.2A-2.4 before merging.
- **The firm/user-voice loader is triplicated with subtly different scopes** (outreach's copy additionally pulls a client-people memory type) — 5.2A-1's consolidation must preserve that superset behavior via a parameter, not silently drop it for the other two callers or silently add it to them.
- **5.1B and 5.2C are coupled** (per D5) — if 5.2C slips, wiring the auditor onto alert-memo in isolation would only check generated prose against its own frozen claim sheet, which is close to circular and would produce misleadingly clean shadow data. Do not report 5.1B's shadow findings as meaningful until 5.2C has shipped alongside it.
- **GA-chat is the highest-traffic surface and currently has zero persisted shadow data** — until 5.1C ships, decisions about the chat enforce timeline are being made on CloudWatch log volume, not queryable ledger data. Treat 5.1C as a blocking prerequisite for any chat-surface enforce discussion, not a nice-to-have.
