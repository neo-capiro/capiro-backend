# Agentic Intelligence Architecture — Event-to-Action for Both Rails

**Date:** 2026-07-09 · **Scope:** the agentic-workflow layer for the state platform **and the
existing federal LegiWatch tracker** — one architecture, two rails (`congress_bill`,
`state_bill`, later `state_rule`). Blueprint only; no implementation code.
**Relationship to other plans:** this doc is what the parent plan's **Rev 3** incorporates
(`2026-07-09-state-legislation-platform-plan.md`); it extends
`2026-07-09-state-phase0-implementation-plan.md` and **subsumes and generalizes LegiWatch
Workstream D** (`2026-07-09-legiwatch-event-coverage-plan.md` §5) — W-D is the first
production instance of this architecture, not a separate thing.
**Grounding:** every claim about existing machinery below was verified against the code at
`87ff019` (file:line anchors); every "does NOT exist" was verified by search. No assumptions.

**Governing principle (adopted verbatim):** _deterministic software establishes truth; agents
interpret, connect, prioritize, and draft against that truth._ The product loop this enables:

> observe → understand → connect → prioritize → recommend → draft → assign → monitor the result

---

## 1. Grounded inventory — what exists, what does not

The design stands on real components. The right-hand column is the architectural consequence.

| Fact (verified)                                                                                                                                                                                                                                                           | Anchor                                                                                                                   | Consequence                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MeriV2 orchestrator accepts **Clerk user JWTs only** — every functional route is TenantGuard'd; `INTERNAL_SERVICE_SECRET` appears nowhere in the orchestrator or meriv2-core; intel-api's one orchestrator call forwards a _user_ token                                   | `packages/auth/src/tenant.guard.ts:52-87`; `apps/intel-api/src/hearing/orchestrator.client.ts:69-75`                     | **No event-driven workflow can run inside the orchestrator today.** A system-principal door is a build item (AD-2), coupled to the pending auth-extraction work (#289)                                                                  |
| A bounded agentic loop **already runs unattended**: `run-clio-scheduled-tasks` — ECS task, no HTTP auth, per-task `TenantContext` (RLS-scoped reads), read-only tool allowlist + FORBIDDEN list, BYOK-first key resolve, MAX_ROUNDS=6, outputs to `clio_proactive_alerts` | `apps/api/scripts/run-clio-scheduled-tasks.ts:93-345`; `apps/api/src/meri/meri-schedule.helpers.ts:26-77`                | **The Tier-2 runner pattern exists.** Event-driven deep workflows generalize this app-side runner; they do not wait for an orchestrator door                                                                                            |
| The **S2S secret realm is apps/api-side only**: `InternalServiceGuard` + `POST /api/internal/ai-credentials/resolve` (BYOK3), consumed by intel-api                                                                                                                       | `apps/api/src/auth/internal-service.guard.ts:25`; `internal-ai-credentials.controller.ts:24-25`                          | Tier-1 enrichment lives behind the same pattern — exactly what LegiWatch W-D already specs (`/api/internal/alert-enrichment`)                                                                                                           |
| **In-rail LLM precedent** (fail-open, grounded, metered): `TrackerSummaryService` — `resolveProviderByTenantId`, 15s abort, returns `null` on any failure, `recordAiUsageEvent('tracker_alert_summary')`, "never invent facts" prompt                                     | `tracker-summary.service.ts:22-205`                                                                                      | Tier-1's template. Fail-open + hard budget + metering are inherited invariants                                                                                                                                                          |
| **Grounding-guard precedent**: alert-memo's closed numbered fact-sheet; model may cite only claim ids; `verifyGrounded` drops paragraphs citing unknown ids; deterministic scaffold fallback with `lowConfidence`                                                         | `apps/api/src/intelligence/alert-memo/alert-memo.service.ts:271-331`                                                     | The evidence-citation contract for every agent output                                                                                                                                                                                   |
| **Approval gate is throw-based, fail-closed** — unapproved write tools throw `ApprovalPendingError` (HTTP 409 / `pending_approval` step); it never parks awaiting a human; scheduled runs simply never attach write tools                                                 | `packages/meriv2-core/src/registry/tool-registry.ts:67-75`; `approval-gate.ts:105-123`; `MeriActionApproval` schema:1311 | Unattended workflows **cannot and must not** call gated write tools. "Approval required" = surface a draft; a human executes through the gated interactive path                                                                         |
| **Metering exists but has gaps**: `ai_usage_events` + `recordAiUsageEvent` (single choke point) — written by engagement + TrackerSummary; **NOT** by the orchestrator loops, the scheduled runner, or alert-memo                                                          | `apps/api/src/engagement/ai-usage-record.ts:32-61`; schema:1501-1520                                                     | All new runs meter through the choke point; the three existing gaps are a hardening item (H-1)                                                                                                                                          |
| **No schema-forced LLM output and no retry anywhere** — universal pattern is prompt-instructed JSON → tolerant parse (`parseJsonObject`) → domain validation → deterministic fallback                                                                                     | `packages/meriv2-core/src/llm/llm-client.ts:90-105`; alert-memo `parseSections`/`verifyGrounded`                         | A shared **GroundedJson** contract is a new build item (§5.3), not an extension                                                                                                                                                         |
| **No LLM-run provenance table** — closest structural precedent is `ProgramElementIngestRun` (per-run status/completeness for deterministic parsers)                                                                                                                       | `apps/api/prisma/schema.prisma:2805-2821`                                                                                | New `ai_run` table (§5.1), modeled on it                                                                                                                                                                                                |
| **PE Watch "quarantine" is deterministic validation-reject-to-table**, not an LLM-confidence mechanism; PE extraction has no LLM anywhere                                                                                                                                 | `program-element-writer.service.ts:291-301`; quarantine table schema:2782-2790                                           | Where the plans say "LLM extraction with the quarantine pattern" (fiscal notes, obligations), the meaning is: **LLM proposes, deterministic validators decide** — quarantine on validator failure, never on model self-confidence alone |
| intel-api has **no LLM client and no BYOK store** (LegiWatch plan §5), and is **read-only against apps/api tables** (the read-only invariant, P0-plan DD4)                                                                                                                | `source-data.repository.ts:9-15`                                                                                         | Enrichment/QA cannot run in intel-api. It calls apps/api's internal endpoint fire-and-forget (W-D), for both rails                                                                                                                      |
| Alert delivery, dedup, suppression, prefs, jurisdictions are DB-constraint/deterministic (#374)                                                                                                                                                                           | `intel_notification_log` unique, 14-day dedup, `LEGIWATCH_EMIT_SOURCE_TYPES`                                             | Agents never touch delivery. Enrichment attaches to alerts; it cannot create, suppress, or route them                                                                                                                                   |

---

## 2. Execution-tier architecture (AD-1)

Do **not** build "a collection of autonomous agents," and do not build a new deployable
"State Intelligence Orchestrator" service. Build the orchestrator as a _logical_ layer across
three execution tiers, each on a proven runtime:

```
        Tier 0 — DETERMINISTIC TRUTH (unchanged)
        ingestion · change_hash diff · watermarks · deriveBillStatus/deriveStateBillStatus
        · dedup/delivery constraints · state_session deadlines · geocoded districts · RLS
                                   │
                        canonical event (envelope, §2.1)
                                   │
        ┌──────────────────────────┼──────────────────────────────┐
        │                          │                              │
  Tier 1 — IN-RAIL          Tier 2 — BOUNDED RUNS          Tier 3 — INTERACTIVE
  single-shot enrichment    unattended agent loops         MeriV2 (exists, GA)
  apps/api internal         apps/api worker verb           user JWT + TenantGuard
  endpoint (W-D),           (run-clio-scheduled-tasks      full-chat/in-editor/
  INTERNAL_SERVICE_SECRET,  pattern), read-only tools      workspace-gen; Policy-
  fail-open, ≤15s,          + deterministic draft          ApprovalGate write tools;
  cached L1 / BYOK L2       writers, MAX_ROUNDS bound      memo/one-pager/outreach
        │                          │                              │
        └──────────────┬───────────┴───────────┬──────────────────┘
                       │                       │
             deterministic VALIDATOR GATE (§5.4) — no output attaches if it fails
                       │
     alert enrichment · opportunity card · obligation record · draft watch ·
     pending action item · draft memo → human review where required (§6)
```

- **Tier 1** = LegiWatch **W-D generalized**: the `/api/internal/alert-enrichment` endpoint
  (INTERNAL_SERVICE_SECRET; the BYOK3 precedent) serves **both rails** — the request carries
  the event envelope, not a congress-specific shape. Single LLM call per task, no tool loop,
  hard 15s budget, fire-and-forget from the emit path, fail-open (alert always delivers with
  verbatim quote + deterministic why). Layer-1 outputs cached per `(rail, ref, changeType,
actionDate)` and shared across tenants (platform key, cheap model — the recommended branch
  of the LegiWatch plan's still-open decision (1); folded into D-A3); Layer-2 outputs are
  tenant-scoped (BYOK via `resolveProviderByTenantId`, metered). **Persistence path, stated
  explicitly (new precedent, blessed here):** apps/api `withSystem`-writes the result onto
  `intel_alert.evidence.enrichment` — a one-directional cross-realm WRITE that leaves
  intel-api's read-only invariant untouched (intel-api still never writes apps/api tables);
  the alternative, intel-api awaiting the response, would contradict fire-and-forget.
- **Tier 2** = a new worker verb **`run-intel-workflows`** generalizing the scheduled-task
  runner: ECS one-off on the existing EventBridge pattern (staggered after the derive chain),
  polls for qualifying triggers (it can read both prisma realms — apps/api owns the truth
  tables and reads intel\_\* under the existing withSystem precedent), executes bounded
  multi-tool runs with per-tenant `TenantContext`, an explicit **read-only allowlist**
  (extending `DEFAULT_SCHEDULED_TOOL_ALLOWLIST` / honoring `FORBIDDEN_SCHEDULED_TOOLS`), and
  writes results **through its own deterministic writers** (never through gated write tools —
  the gate throws in unattended contexts, by design). Polling, not cross-service queues:
  intel-api stays read-only and untouched.
- **Tier 3** = MeriV2 as it exists. Interactive deep dives, drafting to Workspace, outreach —
  where PolicyApprovalGate and human judgment already live. Tier-1/Tier-2 outputs surface
  _into_ Tier-3 flows (an opportunity card carries a "generate memo" action that runs the
  existing user-initiated alert-memo path).
- **AD-2 — the orchestrator system door is deferred, deliberately.** Consolidating Tier 2
  into the orchestrator requires an `InternalServiceGuard` + system-principal `MeriContext`
  in a fail-closed auth file under change control, and interacts with the pending auth
  extraction (#289) and the enterprise-readiness gate-bypass blocker. Until that lands,
  app-side Tier 2 is not a compromise — it is the same pattern the scheduled runner has run
  in prod since 2026-06. Revisit at P2 exit (D-A1).

### 2.1 The canonical event envelope

One contract feeds every tier, both rails (formalizes what the detector already produces —
`MaterialEvent` + the W-C evidence block):

`IntelEventEnvelope`: `rail` ('congress'|'state'|'state_rule'), `sourceType` (the intel_alert
vocabulary: 'bill'|'state_bill'|…), `ref` (billId / stateBillKey / docket ref), `changeType`,
`triggerKey`, `jurisdiction` ('US'|state code), `occurredAt`, `evidence` (the W-C block:
`sourceQuote` verbatim, `sourceUrl`, per-event structured fields — tally, amounts, dates),
`dedupeKey`. Emitted rows already carry all of this after W-C + P0-S4; the envelope is a
named type in `@capiro/shared` beside the canonical `Alert`, so Tier-1/Tier-2 inputs are
typed, versioned, and rail-agnostic. (At P3/O1 the envelope gains a **pre-introduction
sourceType** — agency reports, interim charges, budget requests have no bill `ref`; the
signal-mode spec is deliberately deferred to the O1 bet kickoff rather than guessed here.)

---

## 3. Workflows → roles → tiers → phases (the whole proposal, mapped)

Four logical roles (not ten deployed agents). Every workflow from the proposal lands on a
role, a tier, a phase, and **both rails unless stated**:

| #   | Proposed workflow               | Role                                  | Tier                                                                                          | Phase                                                                                                                                                   | Rails / notes                                                                                                                                                                                                                                                                              |
| --- | ------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Legislative Change Analyst      | Event Analyst                         | 1 (light: explain + materiality assist) → 2 (full: version/amendment diff interpretation)     | P0 light (this IS W-D L1) · P0.5 full — shipped on a **minimal single-mode `run-intel-workflows`** (amendment-diff only; the full worker lands P1, §10) | both — state amendments via `state_bill_amendment`; federal amendment metadata via the Congress.gov amendments sub-resource (the W-B→W-C routing; GovInfo full-text blobs only if diffing later requires them — a NEW source if so, added to the parent inventory then)                    |
| 2   | Client Impact Agent             | Client Impact Analyst                 | 1 (relevance/impact JSON per material event)                                                  | P0 (this IS W-D L2, upgraded to a structured schema §4.2)                                                                                               | both — the federal rail gets impact scoring + prioritization/annotation signals (digest routing deferred to D-A4 at P2; §4.2 posture)                                                                                                                                                      |
| 3   | Money & Fiscal Intelligence     | Opportunity Analyst                   | 2                                                                                             | P2 (with $1/$2/$4)                                                                                                                                      | both — federal = PE/budget-line events feed the same role                                                                                                                                                                                                                                  |
| 4   | Implementation Obligation Agent | Opportunity Analyst (obligation mode) | 2                                                                                             | P2 ($5)                                                                                                                                                 | both — enacted federal bills produce obligations/successor watches identically                                                                                                                                                                                                             |
| 5   | Regulatory Successor Agent      | Opportunity Analyst (successor mode)  | 2                                                                                             | P2 ($5 + M3 substrate)                                                                                                                                  | state first (M3 dockets); federal already has the regs pipeline to link                                                                                                                                                                                                                    |
| 6   | Chokepoint & Targeting Agent    | Opportunity Analyst (targeting mode)  | 2 (event-drafted brief) + 3 (interactive refinement)                                          | P1 (M2 chokepoint data)                                                                                                                                 | both — federal committee/rule chokepoints use the #367 truth layer                                                                                                                                                                                                                         |
| 7   | Multistate Campaign Agent       | Opportunity Analyst (campaign mode)   | 2 drafts weekly report; 3 for interactive planning                                            | **split:** weekly campaign-report draft = P2 ($6 families); full campaign planning + owners/next-actions = P3 (O5 console)                              | state-led; federal companions included via fed↔state links                                                                                                                                                                                                                                 |
| 8   | Pre-Introduction Signal Agent   | Event Analyst (signal mode)           | 2                                                                                             | P3 (O1 substrate)                                                                                                                                       | state first; federal pre-intro (agency reports, budget requests) later                                                                                                                                                                                                                     |
| 9   | Influence Graph Enrichment      | Opportunity Analyst (graph mode)      | 2                                                                                             | P3 (O3)                                                                                                                                                 | both; inferred edges stored separately from sourced edges, with confidence + evidence (per proposal). **Key posture:** globally-stored inferred edges run on the platform key (the parent's $6 global-reference-data rule); only tenant-specific overlays (client/facility views) use BYOK |
| 10  | Analyst QA Agent                | QA Reviewer                           | validators = emit-path code (both tiers); LLM review = 1 (high-materiality) / 2 (run outputs) | P0 validators + shadow LLM QA · P0.5 enforcing                                                                                                          | both                                                                                                                                                                                                                                                                                       |

---

## 4. Role specifications

Common contract for all four (the proposal's guardrails, made enforceable): inputs are the
envelope + tool reads only; outputs are **GroundedJson** (§5.3) with per-claim evidence refs;
every run writes `ai_run` (§5.1) + `ai_usage_events`; every output passes the validator gate
(§5.4) or is dropped (fail-open); prompts are versioned; fact / inference / recommendation are
separate fields, never mixed prose. **Note on tool lists:** the proposal specified tools per
ten agents; because the ten collapse into four roles, per-role tool allowlists are defined at
implementation as named extensions of `DEFAULT_SCHEDULED_TOOL_ALLOWLIST` (one const per role,
spec-pinned like the catalogs), honoring `FORBIDDEN_SCHEDULED_TOOLS` — the "Reads" lines below
name the data surfaces those allowlists must cover.

### 4.1 Event Analyst

- **Trigger:** every material event (Tier 1, at emit time, fire-and-forget) · version/
  amendment posted (Tier 2 — in P0.5 a **minimal single-mode worker** runs amendment-diff
  only; the full worker lands P1, §10).
- **Reads:** bill status + actions + votes + versions/amendments + calendars (existing
  Meri-tool reads / repository reads — all deterministic sources; the concrete per-role
  allowlist is defined at implementation as a named extension of
  `DEFAULT_SCHEDULED_TOOL_ALLOWLIST` — see the §4 note on tool lists).
- **Output:** `{ eventClass, materialityScore, direction: strengthened|weakened|delayed|
redirected|procedural, explanation (≤60w, evidence-cited), beforeAfterQuotes[], confidence }`.
- **Named capabilities (testable):** amendment interpretation must detect **legal-force /
  modality changes** — `shall→may`, mandatory→permissive, added exemptions, eligibility
  narrowing — classified `weakened`/`strengthened` with before/after quotes (the proposal's
  signature case; pinned in the P0.5 eval corpus). **Clause-watch (kill-switch) mode**: the
  same amendment-diff pass evaluates the parent plan's $3 clause-watch primitives
  (definitions, exemptions, preemption, effective dates, "subject to appropriation") against
  tracked bills' registered watch clauses — P2, with $3.
- **Hard rule:** it _explains_ status; `deriveBillStatus`/`deriveStateBillStatus` _establish_
  it. Materiality score is **additive** to the deterministic `scoreShadowAlert` — it can
  raise review priority and annotate; it cannot suppress or create alerts (delivery stays
  deterministic, §7).
- **Failure:** null → alert ships with quote + deterministic why (the W-D invariant).

### 4.2 Client Impact Analyst

- **Trigger:** Tier 1, per (material event × tenant with matching watchlist/tracked bill).
- **Reads:** client profile/KB, watchlist + positions (P0.5 adds `position`/`owner`),
  facilities/districts, prior meetings + work product (tenant-scoped, RLS'd), related
  federal↔state links.
- **Output (the proposal's schema, adopted, with types):** `{ clientId: uuid,
relevance: float 0–1, materiality: 'low'|'medium'|'high', impactTypes: enum[]
(regulatory|appropriation|facility|procurement|reputational|operational),
affectedFacilityIds: uuid[], clientPositionConflict: boolean, recommendedAction: string,
claims: [{ text, kind: fact|inference|recommendation, evidenceIds[], confidence: float }],
confidence: float (overall = min of claim confidences) }` — per-claim confidence lives on
  the claims array (satisfying the §4 per-claim contract); the top-level field is the derived
  floor. Persisted onto `intel_alert.evidence.enrichment.impact` (write path per §2 Tier-1),
  rendered in W-C's email/feed template.
- **Key/metering:** tenant BYOK (`resolveProviderByTenantId`), workflow
  `legiwatch_alert_enrichment` (as W-D specs) — federal and state share the workflow tag +
  a `rail` dimension.
- **Suppression posture (explicit):** in P0–P1 impact output **never suppresses** an alert a
  deterministic subscription would deliver; it prioritizes and explains. A
  low-relevance-digest option (move noise to digest instead of realtime) is a P2 decision
  (D-A4) once precision is measured — this is how "reduce alert fatigue" ships without
  making delivery nondeterministic.

### 4.3 Policy Opportunity Analyst (fiscal · opportunity · obligation · successor · targeting · campaign · graph modes)

- **Trigger:** Tier 2 worker cycles: qualifying events (enacted/chaptered; budget line-item
  appeared/changed; fiscal note landed; amendment adopted; deadline approaching on a
  positioned bill) — plus one **weekly schedule** (not event-driven) for campaign-report
  drafting.
- **Reads:** budgets/fiscal notes/line items, obligations, grants/procurement (P2+), federal
  funding links, chokepoint/district data, client positions (allowlist per the §4 note).
- **Fiscal mode (workflow #3, explicit):** the input stage of opportunity mode, with its own
  outputs when no opportunity results — fiscal-note interpretation `{ costByYear deltas,
fundsAffected, gainers/losers by agency-program, priorStage/priorYear comparison }` attached
  to the fiscalNote alert's enrichment. Dollar figures are always the deterministic
  extraction's; the model interprets and connects.
- **Outputs (all drafts, never sends):** opportunity card `{ programValue$, source refs,
eligibilityHypothesis, affectedFacilityIds[], rulesDueDate, federalInteraction, targets[],
recommendedStrategy, confidence }` · obligation records + **draft** successor watches
  (flagged `draft`, activated by a human or by explicit tenant policy) · **comment-strategy
  brief (draft)** — successor mode's P2 deliverable once M3 dockets exist: what to argue in a
  rule comment, grounded on statute-vs-rule deltas · targeting brief (primary/secondary/
  blocking with evidence: roles, districts, relationship history) · **weekly multistate
  campaign report draft** — produced by the weekly schedule, surfaced on the campaign console
  (P3: O5) and as a tenant digest draft; P2 exit criterion covers it (§10).
- **Hard rules (the proposal's, enforced by validators):** dollar figures must equal
  deterministic extraction; district assignments come from geocode joins; deadlines from
  `state_session`/calendars; the model contributes eligibility _hypotheses_, connections,
  and strategy — each marked inference/recommendation with confidence. Resource-allocation
  recommendations are decision support, never silently executed.

### 4.4 Evidence & QA Reviewer

- **Layer A — deterministic validators (code, not LLM; always on):** §5.4 list. No agent
  output attaches to any surface without passing.
- **Layer B — LLM review (platform key, cheap model):** for high-materiality outputs and all
  Tier-2 artifacts: quotes exist verbatim in source, recommendation follows from evidence,
  no client/entity confusion, no overstated certainty → verdict
  `approved | approved_with_warning | human_review_required | rejected`, persisted on
  `ai_run.validationStatus`/`humanReviewStatus`.
- **Escalation:** `human_review_required` routes to the P0.5 source-quality dashboard (the
  analyst-console seed) — Ballard-facing high-stakes outputs get provenance + QA status
  visible, per the parent plan's trust posture.

---

## 5. Data model, provenance, and contracts (new build items)

### 5.1 `ai_run` (apps/api prisma; modeled on `ProgramElementIngestRun`)

`id uuid` · `workflow VarChar(48)` (matches `ai_usage_events.workflow`) · `rail` ·
`subjectType`/`subjectKey` (envelope ref) · `tenantId?` (null = tenant-agnostic L1) ·
`promptVersion` · `model`/`provider`/`usedTenantKey` · `inputRefs Json` (source record ids) ·
`toolCalls Json` · `output Json` (the GroundedJson) · `confidence Float?` ·
`validationStatus` (passed|failed|skipped) · `qaStatus` (approved|warning|human_review|rejected|none) ·
`humanReviewedBy?/At?` · `status` (ok|failed|timeout|fallback) · `durationMs` · `createdAt`.
Indexes: `(workflow, createdAt)`, `(subjectType, subjectKey)`, `(tenantId, createdAt)`.
Tenant-scoped rows RLS'd like `ai_usage_events`; tenant-agnostic rows global. This satisfies
the proposal's per-output guardrail list (schema, source ids, evidence, confidence, model +
prompt version, run id, tool calls, validation status, human-review status) as **columns,
not prose**.

### 5.2 Metering mandate + hardening item H-1

Every Tier-1/Tier-2 call meters via `recordAiUsageEvent` (the single choke point) with
workflow tags: `legiwatch_alert_enrichment`, `intel_event_analysis`, `intel_opportunity`,
`intel_obligation`, `intel_targeting`, `intel_qa_review`. **H-1 (do early, cheap):** close
the three verified metering gaps — orchestrator chat/in-editor loops, `run-clio-scheduled-tasks`,
`AlertMemoService` — so AI spend is complete before agent volume grows.

### 5.3 GroundedJson contract (new shared helper)

Today's universal pattern is prompt-JSON + tolerant parse + fallback, with **no retry and no
schema-forcing** (verified). Introduce one shared helper (placed in `@capiro/meriv2-core`,
consumed by apps/api Tier-1/Tier-2): schema-instructed prompt + zod validation + **one**
bounded re-prompt on parse/validation failure + deterministic fallback + a
`verifyGrounded`-style citation check (every quoted string must appear in the referenced
source; every claim carries `evidenceIds`). Anthropic tool-forcing (`tool_choice` to a named
tool) is the preferred mechanism where the provider supports it — a deliberate, small
capability addition, flagged as such.

### 5.4 Deterministic validator gate (the proposal's list, as an emit-path contract)

Runs as code before any agent output attaches: quoted passages exist at recorded source
offsets · financial amounts equal deterministically-extracted source amounts · bill
key/docket exists · deadlines match `state_session`/procedural calendars · member↔district
claims match geocoded joins · client/tenant references resolve under the caller's scope ·
output schema validates. **Failure ⇒ the enrichment/artifact is dropped and logged
(`ai_run.validationStatus='failed'`); the underlying deterministic alert/record is never
blocked** — fail-open in both directions.

---

## 6. Automation levels (mapped to real enforcement, not policy prose)

| Level                 | Behavior                                                                                                                                           | Enforcement mechanism (exists / new)                                                                                                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Automatic**         | Attach enrichment to alerts; classify events; write opportunity/obligation records + **draft** watches; create pending action items; file `ai_run` | Tier-1/Tier-2 deterministic writers after the validator gate. Never via gated write tools                                                                                                                    |
| **Approval required** | Publish memo to client docs; assign outreach; change bill position; activate a draft watch as a subscription                                       | Existing `PolicyApprovalGate` (WARN → `ApprovalPendingError` → human approves; `MeriActionApproval` fingerprint) on the interactive Tier-3 path. Unattended tiers _surface_ the draft; a human _executes_ it |
| **Never autonomous**  | Send legislator email; file comments; represent a client position externally                                                                       | Not registered as tools in unattended contexts at all — extend `FORBIDDEN_SCHEDULED_TOOLS`; Outreach/Workspace remain execution tools behind human clicks (+ the gate)                                       |

**Deliberate deviation from the proposal's approval semantics, acknowledged here:** the
proposal implies the system _initiates_ an action and a human approves it in place. Our gate
is throw-based and never parks (§1) — so unattended tiers cannot queue an approval. The
equivalent behavior is achieved by **drafts surfacing as pending action items** (the queue
substitute); a human executes through the gated interactive path, where fingerprint approval
(`MeriActionApproval`) applies. Same safety outcome, different mechanism — chosen because it
is the mechanism that exists and is fail-closed.

**Tenant security invariant (unchanged, restated):** authorization is decided below the agent
layer — TenantGuard/RLS/withTenant/withSystem scoping. Agents receive an already-scoped
context; no agent input or output can widen it. Tier-2 iterates tenants explicitly with
per-tenant contexts (the scheduled-runner pattern), never a cross-tenant prompt.

---

## 7. Where agents are NOT used (the deterministic register — both rails)

Adopted verbatim from the proposal, each bound to its owning component:

- **Canonical bill status** — `deriveBillStatus` / `deriveStateBillStatus` (@capiro/shared),
  written by the derive verbs. Agents explain; they never establish. (This is the H.R. 8800
  lesson made policy.)
- **Ingestion & change detection** — sync verbs, `change_hash` cursors, watermarks,
  `runWithSyncRun`, idempotent upserts.
- **Alert dedup & delivery** — `intel_notification_log` unique keys, 14-day dedup windows,
  prefs/triggers/jurisdictions, `LEGIWATCH_EMIT_SOURCE_TYPES`. Enrichment attaches; it never
  creates, suppresses (see §4.2 posture), or routes.
- **Deadline calculation** — `state_session` + procedural calendars; federal calendars from
  the truth layer. Agents may explain a deadline's consequence; never compute or approximate
  one that exists structurally.
- **District assignment** — Census geocode + official geometry joins (M1). No LLM ever
  answers "which district contains this address."
- **Tenant security** — §6 invariant.
- _(Addition)_ **Scoring that gates delivery** — `scoreShadowAlert`/fit floors stay
  deterministic; agent materiality is annotation and prioritization input only.

---

## 8. Quality, evals, and rollout

- **Two eval lanes (matching the existing split):** deterministic mechanism tests in the
  CI-blocking `meriv2-evals` gate (validator gate behavior, GroundedJson parse/fallback,
  envelope contracts, prompt-version pinning) — plus grounding evals with live LLMs in the
  nightly `clio-evals` harness (0-fabrication corpus per workflow incl. adversarial cases,
  the W-D SC-5 pattern; per-workflow fixtures frozen like the H.R. 8800 pin).
- **Repeatability:** temperature-0 (or provider equivalent), pinned + versioned prompts
  (`promptVersion` on every `ai_run`), fixture-replayable envelopes. A prompt change = a
  version bump + eval-corpus run.
- **Shadow-first rollout per workflow** (the #374/W-E discipline): each workflow ships dark →
  shadow (runs + `ai_run` rows, no surface attach) → canary (capiro-internal) → tenants.
  Independent kill-switch env per workflow (`LEGIWATCH_ENRICHMENT_ENABLED` pattern:
  `INTEL_IMPACT_ENABLED`, `INTEL_OPPORTUNITY_ENABLED`, …).
- **Observability:** extend the W-E weekly coverage verb (`diag-legiwatch-coverage`) with
  enrichment hit-rate, validation-failure rate, QA verdict mix, fallback rate, p95 latency,
  spend by workflow (from `ai_usage_events`) — per rail — **plus the alert-noise measures
  that make the fatigue claim testable:** alerts/client/week, % opened/actioned (feed
  status transitions), and impact-relevance distribution. D-A4's unlock condition is defined
  on these: ≥0.85 agreement between impact `relevance` and human-rated relevance on a
  ≥100-alert sampled corpus (rated via the analyst dashboard) over 4 weeks.

## 9. Cost & latency model

- **Suppression-first:** only _material_ events (deterministic classification) reach any LLM;
  Layer-1 is cached per event across tenants (≤1 call per event regardless of tenant count —
  the W-D SC-5 bound); Layer-2 runs only for tenants with a real association.
- **Budgets:** hard timeout per call (15s Tier-1 / 120s Tier-2 run-total), `MAX_ROUNDS` on
  Tier-2 loops, and a monthly per-workflow token budget enforced at the choke point
  (env-capped, alarmed via the existing SNS pattern) — D-A3 sets the numbers.
- **Model tiering:** cheap model for L1 explanation + QA review (platform key); tenant-BYOK
  default model for client-facing L2/Tier-2 narrative; **any run producing GLOBAL reference
  data (graph-edge inference, family clustering) uses the platform key** — the parent's $6
  rule; never a premium model on a cache-miss hot path.
- **Latency:** Tier-1 is fire-and-forget pre-fan-out (W-D) — delivery never waits beyond the
  budget; Tier-2 is asynchronous by construction (worker cadence), so its latency SLO is
  "within one worker cycle of the triggering event," not realtime.

## 10. Phasing (aligned to the existing roadmap; federal called out per phase)

| Phase    | Agentic scope                                                                                                                                                                                                                                                                                                                                                                                                                                               | Federal application                                                                                                                    |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **P0**   | Tier-1 online = W-C evidence + W-D L1/L2 generalized to the envelope; Client Impact structured schema; deterministic validator gate; `ai_run` + metering from day one; LLM QA in shadow; Meri state tools (P0-S6)                                                                                                                                                                                                                                           | **This IS the federal W-D build** — one endpoint, one schema, `rail` dimension; federal alerts get impact JSON + QA shadow immediately |
| **P0.5** | Full Change Analyst on amendments (state `state_bill_amendment`; federal amendment metadata via the Congress.gov amendments sub-resource) on a **minimal single-mode `run-intel-workflows`** (amendment-diff only); hearing/witness synthesis; next-action recommendations (LLM layer over the deterministic `recommended-actions.util`, fail-open); entity-resolution assistance flagged to the source-quality dashboard; QA enforcing on high materiality | amendment interpretation + next-action recs apply to federal alerts unchanged                                                          |
| **P1**   | Tier-2 worker (`run-intel-workflows`) grows to the full mode registry, shipping **targeting-brief mode** (M2 chokepoints + M1 districts); rules-comparison assists (M3); cross-jurisdiction Meri research (Tier 3)                                                                                                                                                                                                                                          | federal targeting briefs from the #367 committee/vote truth layer; same worker                                                         |
| **P2**   | Tier-2 central: fiscal/opportunity/obligation/successor modes + **clause-watch (kill-switch) in the Event Analyst's amendment pass** (§4.1, with $3) ($1–$6); draft successor watches + comment-strategy briefs; weekly campaign-report drafts; D-A4 (impact-informed digest routing) decided on the §8 precision metric                                                                                                                                    | PE/budget-line events feed the same Opportunity Analyst; enacted federal bills produce obligations/successor watches                   |
| **P3**   | Pre-intro signal detection (O1); influence-graph enrichment (O3, inferred edges separated + confidence); Government Decision Timeline synthesis (O4 = agentic join over P0–P2 nodes); full multistate campaign mode                                                                                                                                                                                                                                         | fed↔state transmission analysis is inherently two-rail                                                                                 |

**Per-phase exit criteria (testable):** P0 — W-D SC-5 holds for both rails (0 fabrications on
the eval corpus; fail-open proven; ≤1 L1 call per event; `usedTenantKey` metered rows); every
attached enrichment has a passing `ai_run.validationStatus`. P0.5 — an adopted committee
substitute produces a before/after-quoted interpretation that survives the validator gate,
**and the amendment-diff eval corpus includes modality changes (`shall→may`,
mandatory→permissive) that must classify `weakened` with quotes**; QA blocks a seeded
fabrication (red-provable). P1 — a targeting brief on a real bill names only members whose
roles/districts validate deterministically. P2 — the $4/SC-10 opportunity card is
agent-drafted, validator-passed, and carries full provenance; **a weekly campaign report
draft is produced on schedule for a staging campaign fixture with per-state status +
deadlines that match the procedural calendars**. Each workflow's shadow→canary→GA gates use
its own eval corpus.

## 10.1 Worked example — the proposal's Florida scenario, mapped to real components

1. **Tier 0:** LegiScan drain detects an FL bill amendment → `state_bill_amendment` row +
   status recompute; the detector emits the material event (envelope §2.1) and writes the
   `intel_alert` with the W-C evidence block. Delivery/dedup proceed deterministically —
   nothing below waits on any agent.
2. **Tier 1 (fire-and-forget, ≤15s):** Event Analyst L1 explains the amendment (cached once
   for all tenants); Client Impact L2 runs per affected tenant → impact JSON (§4.2):
   eligibility definition narrowed (two facilities `affectedFacilityIds`,
   `clientPositionConflict: true`), appropriation +$40M (amount validated against the
   deterministic extraction), rulemaking deadline added. apps/api `withSystem`-writes both
   onto `evidence.enrichment`; validator gate passes; email/feed render quote + impact.
3. **Tier 2 (next worker cycle):** Opportunity Analyst — fiscal mode interprets the fiscal
   note; opportunity mode drafts the card (program value, eligible facilities, chair's
   district from M1/M2 joins, federal match link, 7-day committee deadline from the
   procedural calendar); obligation mode records the rulemaking mandate and creates a
   **draft** successor watch; targeting mode drafts the brief (amendment sponsor, chair,
   companion sponsor). QA Reviewer validates quotes/amounts/deadline/districts →
   `approved`; all rows carry `ai_run` provenance.
4. **Surfaced:** high-priority alert (already delivered), opportunity card, draft watch, and
   a pending next action land in the feed/console.
5. **Tier 3 (human):** the lobbyist opens the alert → "generate memo" runs the existing
   alert-memo path (grounded fact-sheet, `verifyGrounded`); the district one-pager generates
   via the M1 Workspace doc type; outreach is drafted and **sent only by the human** through
   the gated Outreach flow (never-autonomous tier).

Every artifact names its landing place: `intel_alert.evidence.enrichment`, `ai_run`,
opportunity/obligation records, draft watch rows, Workspace docs, Outreach drafts.

## 11. Decisions (D-A1…D-A6)

| #    | Decision                                                                                                                                                                                               | Recommendation                                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| D-A1 | Orchestrator system-principal door (consolidate Tier 2 into meriv2)                                                                                                                                    | Defer to P2 exit; couple to auth extraction #289; app-side worker is the proven pattern meanwhile                             |
| D-A2 | GroundedJson placement + provider tool-forcing                                                                                                                                                         | meriv2-core helper; adopt Anthropic tool-forcing where available; one bounded retry max                                       |
| D-A3 | Per-workflow monthly token budgets + timeout envelope + **Layer-1 key/model choice** (the LegiWatch plan's open decision (1): global cheap vs per-tenant — recommendation: global cheap, cache-shared) | Set at P0 canary from measured L1/L2 costs; alarm at 80%                                                                      |
| D-A4 | May Client Impact route low-relevance alerts to digest (soft suppression)?                                                                                                                             | Decide at P2 against the §8 unlock metric (≥0.85 human-agreement on a ≥100-alert corpus over 4 wks); until then annotate-only |
| D-A5 | Draft-watch auto-activation policy (per tenant?)                                                                                                                                                       | Default: human activates; revisit per design-partner feedback                                                                 |
| D-A6 | H-1 metering-gap backfill priority                                                                                                                                                                     | Do in P0 alongside `ai_run` — one PR, three call sites                                                                        |

## 12. Risks

- **Grounding drift** → versioned prompts + per-workflow eval corpus + validator gate; QA
  red-provable in CI.
- **Cost blowout** → suppression-first, L1 caching, budgets at the metering choke point,
  per-workflow kill-switches.
- **Emit-path latency** → fire-and-forget + hard budgets; enrichment can never delay or block
  delivery (inherited W-D invariant).
- **Unattended-write accidents** → structurally impossible: throw-based gate + read-only
  allowlists + FORBIDDEN list + drafts-only writers.
- **Trust erosion from one bad high-stakes output** → QA layer + provenance visible on the
  analyst dashboard + human-review routing before Ballard-facing distribution of
  high-materiality artifacts.
- **Two-realm auth confusion** → this doc's tier placement is the rule: S2S secret realm =
  apps/api internal endpoints; Clerk realm = orchestrator; no new ad-hoc auth paths.
