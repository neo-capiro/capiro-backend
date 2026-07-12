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
- **3.3 — "Context used in this draft" panel — NEXT.** Persist ws_context_item
  ids + injected memory_items ids at generation time; `GET /drafts/:id/context-
  used`; web panel. `loadSteeringMemories` must also select id/type/slug (drops
  identity today) with the same renderHuman/empty filter, or the panel misstates
  what actually grounded the text.
- **3.1 — claim-level citations — AFTER 3.3.** Tier-1 (no wiring): synthesize a
  ToolResultLedger over the fixed evidence (linked PEs by code + ws_context_items
  with id in the serialized body), emit record_ids in `buildSectionPrompt`, allow
  `[S:...]` tokens in the output-format instruction, add a post-LLM
  `validateFormBCitations` pass (from `@capiro/shared`, already a dep), persist
  findings via `computeStructuralWarnings`/`persistGeneratedSections`. Then an
  isolated PR wires `@capiro/meriv2-core` into apps/workspace (Dockerfile mirror
  of apps/api — copy meriv2-core's OWN node_modules or MODULE_NOT_FOUND crashloop;
  gate on `nest build` + a container smoke-boot). Then Tier-2 = `checkCitations`/
  `runAuditor` + import `serializeRecordForGrounding` (no 4th copy).
- **3.4 — memory write-back — LAST.** New InternalServiceGuard `POST
  /api/internal/memory/candidates` on apps/api → existing
  `MemoryCandidateService` (do not touch the candidate engine); clone
  intel-api's `x-internal-service-secret` client on the workspace side; reuse the
  MemorySaveRequest shape. Prereq: `INTERNAL_SERVICE_SECRET` on the workspace ECS
  task def, applied OUT-OF-BAND (CDK↔task-def drift); route fail-closed when unset.

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
- **G1** (citations), **G3** (context panel), **G4** (memory write-back) — pending
  (3.1 / 3.3 / 3.4).
