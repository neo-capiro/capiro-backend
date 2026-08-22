# Phase 27F — Institutional-Context Effectiveness Evaluation

Phase 27E (`quality_telemetry_event`) proved an observational fact: *context
X was present, outcome Y followed* — never a causal claim. Phase 27F adds
the first CONTROLLED comparison: for a bounded, deterministic sample of real
requests, replay the same generation with the five institutional
SteeringLayers withheld (authoritative facts, retrieval, and evidence stay
identical) and record deterministic product metrics comparing the two
outputs. This still cannot attribute an effect to any single memory item —
that is future, per-layer-ablation work — but it is the first mechanism
that can support "withholding institutional context changed metric Z" for
the sampled population.

## What this is — one small table, no second generation stack

`EvaluationRecord` (`apps/api/prisma/schema.prisma`) is ONE new table,
deliberately small: it references `ContextPacket` and
`QualityTelemetryEvent` by id rather than duplicating either. Evaluation
never mutates a production ContextPacket, memory item, memory candidate, or
LearningSignal, and an evaluation's own judgment can never become one
either (`scripts/check-evaluation-new-bypasses.mjs` §9 — the no-AI-
evaluates-AI-feedback-loop invariant, checked repo-wide).

There is no second RAG stack, prompt stack, or vector store. Every control
arm reuses the EXACT product code the real request already used
(`EvidencePacketService.compileOutreachPacket`, `MessagePlanService.
buildPlan`, `AuthorStyleProfileService.getProfile`, `buildGatewayPrompt`,
`LlmCompletionService.complete`, `GenerationVerifierService.verify` for
Outreach; `ClientProfileFillService`'s own `extractPublicWeb`/
`extractCapabilitiesFromDocument` for CRM Fill) — the only thing that ever
differs between the treatment and control call is which packet variant
feeds it.

## The control projection

`buildInstitutionalContextControlProjection` (`packages/meriv2-core/src/
evaluation/contract.ts`) is a structural, packet-shape-agnostic function:
it returns a NEW plain object with `items: []`, `rendered: []`, and a
synthetic `evaluation_control_withheld` exclusion recorded for each of the
five frozen layers — every other field (`evidenceRefs`, `coverageManifest`,
`resolvedEntities`, `subjectScope`, `sourceHealth`, `sourceFreshness`,
`retrievalCompleteness`, ...) is copied through untouched. Never mutates
its input.

This works because every entry in a ContextPacket's `items`/`rendered`
arrays is layer-tagged (`ContextPacketItemV2.layer: SteeringLayer`,
`packages/meriv2-core/src/context/contract.ts`) — there is no non-
institutional item hiding inside those arrays. Authoritative facts live in
a structurally SEPARATE rail (`evidenceRefs`, retrieval records) that the
projection never touches. Confirmed for all three wired surfaces:

- **Meri** (`buildMeriContextPrompt`, `meri-context-plane.service.ts`):
  "GOVERNED STEERING" (from `packet.rendered`) and "RETRIEVED EVIDENCE"
  (from `context.retrieval.records`, never from the packet) are two
  separate rendered sections.
- **Outreach** (`EvidencePacketService.compileOutreachPacket`): calls
  `projectStandingMemory(request.governedContext.packet)` fresh on every
  invocation — passing a control-projected packet as `governedContext`
  yields an `EvidencePacketV2.standingMemory` that is correctly empty,
  while `evidence`/`coverage`/`recipientEmails`/policy stay identical.
- **CRM Fill** (`buildModelContextBlock`, `client-profile-fill-context-
  plane.service.ts`): renders `packet.rendered` into the "GOVERNED
  STEERING" section of `modelContextBlock`; a control-projected packet
  yields `"(no approved steering items selected)"` there, with the
  "CANONICAL CRM IDENTITY" and "RETRIEVAL COVERAGE" sections unchanged.

## Eligibility, sampling, cost — all pure functions

`decideEvaluationEligibility` and `shouldSampleForEvaluation`
(`packages/meriv2-core/src/evaluation/contract.ts`) are pure, unit-tested
functions. Eligibility runs first and can report `feature_disabled`,
`unsupported_operation`, `sensitive_operation`, `missing_packet`,
`insufficient_authoritative_input`, `no_institutional_context`,
`provider_unavailable`, or `budget_exceeded`; sampling is a SEPARATE,
deterministic (SHA-256-keyed, never `Math.random()`) decision that can only
report `not_sampled`. Both reasons share one vocabulary
(`EVALUATION_SKIP_REASONS`) so `EvaluationRecord.skip_reason` never needs a
second CHECK constraint depending on which stage produced the skip — and no
request is ever silently dropped without a recorded reason.

`LEARNING_EVALUATION` (dark-by-default, same `qualityTelemetryEnabled`
convention) and `LEARNING_EVALUATION_SAMPLE_RATE` (defaults to `0` — no
sampling until deliberately configured) are both **unset in this PR**.
Nothing in this phase runs against real traffic until both are explicitly
armed.

## Execution model — in-process, not a durable job queue

Deliberate departure from the `outreachJob`-style `FOR UPDATE SKIP LOCKED`
poller pattern used elsewhere in Engagement: a control replay's INPUTS
(the governed packet, evidence, prompt ingredients) are ephemeral and must
never be persisted (§25 — no prompt/output bodies), so there is nothing a
later worker could resume from. Each surface instead fires a **detached,
fire-and-forget task at generation time** — `void runner.considerAndRun(...)
.catch(() => undefined)`, started only AFTER the real request has already
completed and (where applicable) its version is durably persisted — the
same pattern `ClientProfileFillService.startRun` already uses for its own
primary detached execution (`void this.executeRun(...).catch(...)`). A
slow, failing, or throwing evaluation can never affect or delay the real
response.

`EvaluationRecord.status` (`pending → running → completed|failed|skipped`)
is a status machine on one row, not an audit ledger — `EvaluationCaptureService`
grants `UPDATE`, unlike `quality_telemetry_event`'s append-only grants. Its
`(status, created_at)` index supports only a future staleness sweep (mark an
abandoned row `failed` after a timeout); it is NOT a work-claiming queue —
an abandoned row can never be resumed, because the replay's inputs were
never persisted in the first place.

## Coverage by surface

| Surface | Eligibility + sampling | Control replay |
|---|---|---|
| **Outreach** | Real, wired at `GenerationGatewayService.generate()`'s success path (`OutreachEvaluationRunner`) | **Full.** Recompiles a NEW, separate `EvidencePacketV2` from the control-projected packet, rebuilds style profile/plan/prompt, makes one real second `LlmCompletionService.complete()` call, and runs the SAME `GenerationVerifierService.verify()` the product path gates on — against the control output — as a deterministic metric. |
| **CRM Fill** | Real, wired at `extractPublicWeb`/`extractCapabilitiesFromDocument` (`CrmFillEvaluationRunner`, invoked from `governed-client-profile-fill.factory.ts`) | **Full.** Re-invokes the SAME private extraction method a second time under a control-projected governed bundle (via the existing `governedRun` AsyncLocalStorage seam) — a genuinely non-mutating replay: `addFinding` is never called from the control path, so no `client_profile_fill_finding` row is ever written for it. Evaluation unit is one source-extraction call within a run (`{packetId}:public_web` / `{packetId}:capability_document`), not one finding — CRM Fill has no per-finding ContextPacket (`crm-fill-finding.telemetry-adapter.ts`'s own doc comment), so `crm_fill_extraction` is a new `treatment_artifact_type` value this table needed that `quality_telemetry_event` never did. |
| **Meri** | Real, wired at `streamResearch` (`governed-meri-research.factory.ts`) — every Deep Research turn genuinely records a decision. | **Not implemented.** `operationSupported: false` is hardcoded, so every decision is `skipped`/`unsupported_operation` today. Reason: Meri's plain chat turn has no ContextPacket at all (confirmed — `grep` for `ContextPlaneGatewayService`/`requestContext(` in `meri.service.ts` returns zero matches); the only Context-Plane-backed Meri path is Deep Research's `streamResearch`, and that is a full multi-turn agentic loop with real side effects (tool calls, a persisted report), not a single isolated generation call like Outreach's or CRM Fill's extraction methods. Building a safe, non-mutating shadow replay for a multi-turn agent is materially larger scope, deliberately deferred rather than faked. Flipping `operationSupported` to `true` and adding the replay is a pure additive follow-up — the eligibility/sampling/recording path is already live and tested. |

This deviates from the original handoff's suggested build order (CRM Fill
first, as the "safest" narrow proof). Direct code reading reversed that
ranking: CRM Fill's real run is a detached, multi-source, multi-call
pipeline that writes `client_profile_fill_finding` rows as its normal
behavior, while Outreach's `GenerationGatewayService.generate()` is a
single packet → single plan → single draft call with an existing
`packetId` passthrough concept already built in — architecturally the
safer, cleaner first proof. CRM Fill turned out to be equally achievable
once its extraction/persistence seam was read in full (`extractPublicWeb`/
`extractCapabilitiesFromDocument` never call `addFinding` themselves), so
both ended up fully wired; Meri's Deep Research loop is the one surface
whose architecture does not support a narrow, safe replay yet.

## Deterministic metrics (no default LLM judge)

No model judge is used anywhere in this phase. Metrics are computed from
existing product code and existing helpers:

- **Outreach**: `computeEditMetrics` (reused from `quality-telemetry/edit-
  metrics.helpers.ts`, not reimplemented) for `normalizedEditDistance`/
  `percentChanged` between treatment and control body text; body-length
  comparison; and — the one genuinely new idea — running the REAL
  `GenerationVerifierService.verify()` against the control output, so
  `controlVerifierHeld`/`controlVerifierFindingCount` answer "does the
  institutional-context-withheld draft still pass the same deterministic
  gates the real pipeline enforces."
- **CRM Fill**: proposed-candidate counts and a Jaccard-style name-overlap
  ratio (`|treatment ∩ control| / |treatment ∪ control|`) across each
  extraction's `people`/`facilities`/`capabilities` name lists.

`EvaluationJudgeResult` exists as a typed, versioned, blinded-by-
construction shape (`packages/meriv2-core/src/evaluation/contract.ts`) for
a future optional judge — unused by any wired surface in this PR.

## Privacy, isolation, idempotency

- `assertNoConfidentialEvaluationContent` (mirrors Phase 27E's own guard
  byte-for-byte) rejects a banned content-shaped key or an over-long string
  in `metrics`/`judge`/`cost` before any write — enforced at runtime on
  every `recordDecision`/`markCompleted` call, and by a static repo-wide
  census in `check-evaluation-new-bypasses.mjs`.
- Only `treatmentOutputHash`/`controlOutputHash` (sha256) identify an
  output — never the body.
- `evaluation-tenant-isolation.spec.ts` mirrors the exact `fakeScopedPrisma`
  pattern from `quality-telemetry-tenant-isolation.spec.ts`;
  `tenant-scope-guard.spec.ts` auto-covers `EvaluationRecord` (it carries a
  `tenantId` column) with zero changes needed to that guard.
- `computeEvaluationIdempotencyKey` folds in `configVersion`, so a retried
  delivery of the same underlying event reaches the SAME row
  (`recordDecision` returns `{status: 'duplicate'}` rather than creating a
  second one), while a deliberate re-evaluation under a new rubric/policy
  version is correctly a new row.

## Known gaps, carried honestly (not hidden)

- Meri's control-arm replay: not implemented (see table above).
- Workspace/Strategies/MeetingDebrief/MeetingNote: not wired for
  evaluation, same as Phase 27E's own disclosed gap for these surfaces —
  they have no wired quality-telemetry call site to piggyback eligibility
  recording on either.
- `EvaluationCost.estimatedCostUsd` is always `null`: no existing per-
  token pricing table was found to reuse, and inventing one was out of
  scope. `inputTokens`/`outputTokens`/`providerDurationMs` are real,
  measured values wherever a control call actually runs.
- `EVALUATION_CONFIG_VERSION` bundles the eligibility policy, sampling
  policy, control-projection policy, and metric rubric into ONE version
  string rather than four independently-versioned dimensions — a
  disclosed MVP simplification; bump it whenever ANY of the four changes.
- No durable work-claiming queue (see "Execution model" above) — by
  design, not an oversight, given the input-persistence constraint.
- No read/analytics API beyond `EvaluationQueryService.getArtifactEvaluations`
  — sufficient to prove the mechanics end to end, not a dashboard.

## Validation

`pnpm validate:knowledge-plane:phase27f` (new) complements, does not
replace, `:phase26`/`:phase27`/`:phase27e`. All four passed together on
this branch, plus the full pre-existing regression suites for every file
this phase touched (`generation-gateway.service.spec.ts`,
`outreach-draft.service.spec.ts`, `outreach-v3-draft-approval.service.spec.ts`,
`outreach-v3-drafts-architecture.spec.ts`, `client-profile-fill*.spec.ts`,
`governed-client-profile-fill.factory.spec.ts`,
`governed-meri-research.factory.spec.ts`) — zero regressions.
