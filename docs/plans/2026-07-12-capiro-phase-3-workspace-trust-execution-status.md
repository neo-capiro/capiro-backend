# Phase 3 — Make Workspace Trustworthy — Execution Status

Companion to Ninja's Phase 3 plan. Unlike Phases 2/2.5 (mostly pre-built), Phase
3 is genuinely greenfield — all five workstreams were not-started at kickoff
(audit-verified 2026-07-12).

## Decisions (resolved 2026-07-12)

- **D1 — reintroduce an approval gate? → NO, stay GATE-LESS (Ninja).** Workspace
  never hard-blocks export. The 11 advisory rule-based checks (+ the new Phase 3
  claim-level citations) are the trust signal. Consequence: workstream 3.2 flips
  from "build a risk-tiered gate" to "delete the vestigial `gates`/`WsGateResult`
  dead code." (The old gate was removed because it was universal + un-clearable,
  not because gating-as-a-concept was wrong — but Ninja's call is no gate at all.)
- **D2 (tier mapping)** — N/A (gate-less).
- **D3 (citation enforcement scope)** — default: advisory findings (ride the
  existing checks/structuralWarnings path), not silent-strip, not block.
- **D4 (context panel semantics)** — default: as-of-last-generation provenance
  (honest), not "currently attached".
- **D5 (write-back UX)** — default: reuse the existing admin candidate queue,
  tagged with a distinct source_kind (not the hardcoded 'explicit_user').

## Workstream status

- **3.5 — delete dead mock context endpoints — DONE (this PR).**
  Removed `ContextService.sources()`/`news()` (hardcoded `mock:true` stubs) + the
  `ContextController` `/context/sources` + `/context/news` routes + the now-unused
  `splitCsv` + the module registration; kept `DraftContextController` (item CRUD).
  Coupled int-spec assertion (`context.sources(...)`) removed. Confirmed zero
  consumers (the Context Builder UI sources real client data from the main api).
- **3.2 — delete vestigial gate dead code — DONE (this PR), per D1=gate-less.**
  Removed `WsGateResult` + the always-empty `gates: []` field from
  `WsChecksResponse` on BOTH the workspace service and the web type. The 11
  advisory checks + `score:{passed,total}` are untouched (verified: that's the
  only trust signal the surface has and export reads it). No component rendered
  `gates` (always `[]`), so removal is behavior-neutral.
- **3.3 — "Context used in this draft" panel — DONE.** `generateSection`/
  `generateAllSectionsInProcess` now capture an as-of-last-generation
  `ContextProvenance` (context items that contributed a non-empty body + the
  memory files that actually reached the prompt + linked PE codes) and persist it
  into `ws_draft.config.contextProvenance` (preserved, not wiped, by an
  orchestrator-driven apply). `loadSteeringMemories` now also selects id/type/slug
  and returns `memoryFiles` for the files whose rendered body was non-empty (same
  filter as the prompt). New `GET /workspace-api/drafts/:id/context-used` (shape-
  normalized, null before first generation) + a "Context used" panel on the
  Preview page beside the advisory checks. Tests: getContextUsed read/null/404/
  normalize + provenance-preservation on apply (8/8 workspace spec green);
  web typecheck + workspace nest build clean.
- **3.1 — claim-level grounding — DONE.** Wired `@capiro/meriv2-core` into
  apps/workspace (package.json + lockfile + Dockerfile mirror of apps/api,
  incl. the meriv2-core-own-node_modules copy that avoids the MODULE_NOT_FOUND
  crashloop). `generateAllSectionsInProcess` now runs the SHARED Phase 2
  `runAuditor` (`surface:'memo'`, shadow) post-hoc over the generated sections
  against a `get_pe_budget_timeline` ledger synthesized from the draft's
  AUTHORITATIVE linked-PE records — the same deterministic checks (reversed
  funding direction D4, vehicle conflation D4b, LI-as-PE D7, …) that guard
  chat/outreach/alert-memo, not a Workspace reimpl. Findings persist to
  `config.groundingFindings` and `ChecksService` folds them into the EXISTING
  advisory checks list (`Grounding — <check>`; advisory only per D1 gate-less),
  so documents stay token-free. Import is via meriv2-core SUBPATH exports
  (`./grounding/auditor` + `./grounding/evidence`) — added to meriv2-core's
  package.json — so only auditor+evidence (no zod) enter the workspace graph;
  jest maps the subpaths to source (node/nest honor the exports map at
  runtime/build). Tests: `runGroundingAuditor` catches a reversed-direction
  claim + no-false-positive + empty (3 new; 11/11 workspace spec green).
  Typecheck + nest build clean. (Pre-existing, unrelated: cascade.spec 10-vs-11
  product count + pe-resolver.spec fail on main too — not touched here.)
- **3.4 — memory write-back — DONE (code).** apps/api: new
  `InternalServiceGuard`-gated `POST /api/internal/memory/candidates`
  (`InternalMemoryController`) that resolves the Clerk id → Capiro user (fail-
  closed if none) and calls the EXISTING `MemoryCandidateService.proposeSaveMemory`
  as a firm-scope, non-admin, `workspace_artifact`-tagged proposal — so it lands
  'pending' in the existing admin review queue (never auto-committed, never a raw
  insert). `proposeSaveMemory` got one additive optional `sourceKind` param
  (default 'explicit_user' — every existing caller unchanged). apps/workspace: a
  fail-closed `MemoryPromotionClient` (x-internal-service-secret, cloned from
  intel-api's pattern; throws if the secret is unset — never a silent no-op) +
  `MemoryPromotionService` + an EXPLICIT user-triggered `POST
  /workspace-api/drafts/:id/promote-memory` (note-first, draft-context fallback,
  stable key `workspace-artifact:<draftId>`). Artifact approval and memory
  promotion stay separate decisions (§6.4). Tests: api controller (fail-closed +
  firm-scope + workspace_artifact delegation) + workspace client fail-closed +
  service key/value (10 new; green). Typecheck + nest build clean both apps.
  ⚠️ DEPLOY PREREQ: `INTERNAL_SERVICE_SECRET` must be set on the
  `capiro-dev-workspace` task def OUT-OF-BAND (the same secret api/intel-api
  already share; CDK↔task-def drift discipline). Until then the client is
  fail-closed → promotion returns 503, nothing else affected.

## Rollout note

Workspace deploys SEPARATELY (`workspace-image.yml`; `capiro-dev-workspace-migrate`
one-off before rolling `capiro-dev-workspace`; serve mode doesn't migrate). This
cleanup PR has no migration and no new dependency, so it's a plain image rebuild +
`capiro-dev-workspace` roll.

## Exit gate (§10) — running status

- **G5** dead mock endpoints deleted — **MET** (3.5).
- **G6** zero regression to the 11 checks / low-tier export / Reviewer-role — **MET
  so far** (gate deletion is behavior-neutral; checks + score untouched).
- **G2** risk-tiered gate — **N/A by decision** (D1 = gate-less; the vestigial
  type is deleted instead).
- **G3** "Context used in this draft" panel live (memory + context-item sources) —
  **MET** (3.3).
- **G1** claim-level grounding reusing Phase 2/2.5's auditor (not a duplicate) —
  **MET** (3.1).
- **G4** approved-artifact → memory candidate via Phase 1's real lifecycle (not a
  bypass insert), promotion separable from artifact approval — **MET (code)** (3.4);
  live once `INTERNAL_SERVICE_SECRET` is on the workspace task def.

## Phase 3 — COMPLETE (all workstreams landed)

3.5, 3.2, 3.3, 3.1 shipped + deployed; 3.4 code merged (its write-back activates
when the workspace task-def secret is applied out-of-band). D1 resolved
gate-less. Exit gates G1/G3/G4/G5/G6 met; G2 N/A by decision.
