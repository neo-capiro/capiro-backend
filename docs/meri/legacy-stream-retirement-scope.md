# Legacy V1 `streamMessage` retirement — scoping document

> **Status: SCOPING ONLY. No code is retired by this document or the PR that adds it.**
> Written 2026-09-18 against `origin/main` 411d49a08 (Meri Part 3, Phase C3 / item B3 of
> `.hermes/plans/2026-09-18_112500-meri-runtime-flag-trace.md`). Line numbers refer to
> that tree. Anything marked *(inferred)* was not verified by executing code.

## 0. Summary

| Question | Answer (verified unless marked) |
|---|---|
| What is "V1"? | The in-process agentic chat loop inside `MeriService.streamMessage` — `apps/api/src/meri/meri.service.ts` lines 587–2149 (1,563 lines including the signature). The V1-only part is lines 1025–2149; lines 606–1023 are a **shared prelude** that the MeriV2 proxy branch also depends on. |
| Who is served by V1 today? | Effectively nobody. All 9 live tenants pass the MeriV3 three-key canary gate, so every full-chat turn (including impersonated ones) takes the V3 branch in `meriv3-runtime.proxy.ts`. V1 is reached only after a V3 key closes **and** the turn is impersonated, the tenant carries `meriv2.fullChat=false`, or the orchestrator is unconfigured. It is the rollback-of-a-rollback path, not dead code. |
| Can a token-less caller reach V1? | **No — not over HTTP.** `TenantContextMiddleware` rejects every `/api/clio/*` request without `Authorization: Bearer <Clerk JWT>` with 401 before the controller runs. The `bearerToken &&` arm of `shouldRouteMeriV2FullChat` is reachable only from in-process unit specs. See §5. |
| Is V1 safe to delete now? | **No.** Deleting the loop today would (a) remove the only runtime that answers when the orchestrator process is down (both V2 and V3 are served by `apps/meriv2-orchestrator`), (b) leave impersonated turns on any non-V3 tenant with no runtime at all (V2 containment still excludes them), and (c) break the Phase-19 monkey-patches in `meriv3-runtime.proxy.ts` that reach into the raw service's private seams. See §7. |
| Recommendation | A multi-PR project (§7) gated on an observed-zero-V1-turns window, an impersonation decision, and proxy simplification (B4). Estimated deletable surface ≈1,125 lines of loop body plus V1-only private helpers and config keys. |

## 1. Routing chain (verified against code, specs and the live task definitions)

```
POST /api/clio/conversations/:id/stream                     meri.controller.ts:274-346
  │  TenantContextMiddleware: Bearer REQUIRED (401 otherwise)  tenant-context.middleware.ts:112-114
  │  bearerToken = trimmed Authorization capture | undefined    meri.controller.ts:311-312
  │  impersonateTenantId = trimmed x-capiro-impersonate-tenant | undefined   :306-310
  ▼
MeriService token = Proxy (meriv3-runtime.proxy.ts createMeriRuntimeService; meri.module.ts:129-136)
  │  every turn wrapped in governedRuntime.runChatTurn (Phase 19 Context Plane)
  ├─ meriv3.shouldHandle(ctx) = MeriFeatureFlagsService.isMeriV3ChatEnabled(tenantId, tenantSlug)
  │     MERIV3_ENABLED==='true' ∧ slug ∈ MERIV3_CANARY_TENANT_SLUGS ∧ clioFeatureFlags['meriv3.fullChat']===true
  │     → TRUE  ⇒ MeriV3ProxyService.streamMessage   (V3; hard-fails without a bearer, meriv3-proxy.service.ts:98-106)
  │     → FALSE ⇒ raw MeriService.streamMessage
  ▼
raw MeriService.streamMessage (meri.service.ts:587)
  │  shared prelude (§2.1): validation, user-message persist, rerun plan, compliance block,
  │  history + attachment replay, Deep-Research promote gate
  ├─ shouldRouteMeriV2FullChat({ bearer, configured, enabled, impersonateTenantId })   :986-998
  │     bearer ∧ MERIV2_ORCHESTRATOR configured ∧ meriv2.fullChat (MERIV2_ENABLED ∧ tenant default-on) ∧ ¬impersonated
  │     → TRUE  ⇒ streamMessageViaMeriV2 (V2 orchestrator proxy branch, §2.3)      :999-1023
  │     → FALSE ⇒ legacy in-process V1 loop (§2.2)                                    :1025-2149
```

Live gate values (2026-09-18, read-only `aws ecs describe-task-definition`; see the annotation blocks in
`meriv3-runtime.proxy.ts` and `common/meriv3-flags.ts`):

| Gate | Live value | Consequence |
|---|---|---|
| `MERIV3_ENABLED` | `true` on `capiro-dev-api:384` and `capiro-dev-meriv2-orchestrator:65` | V3 key 1 open |
| `MERIV3_CANARY_TENANT_SLUGS` | all 9 tenants (abramoff appended 2026-09-18 on api:383/orch:65) | V3 key 2 open for every tenant |
| `clioFeatureFlags['meriv3.fullChat']` | `true` on all 9 tenants (flag parity applied 2026-09-18) | V3 key 3 open ⇒ **every turn is V3** |
| `MERIV2_ENABLED` / `MERIV2_ORCHESTRATOR_URL` | `true` / `https://app.capiro.ai` | V2 would take any bearer turn that V3 declined |
| `meriv2.fullChat` | tenant default ON since GA 2026-07 (`tenant-flags.ts:57-69`); no explicit `false` found | same |

Both gates are pinned by truth-table specs added alongside this document:
`apps/api/src/meri/meriv2-routing.matrix.spec.ts` (V2, 16 boolean cells + representations) and
`apps/api/src/meri/meri-feature-flags.matrix.spec.ts` (V3, 12 cells + representations).

## 2. Anatomy of `streamMessage`

### 2.1 Shared prelude — runs for BOTH the V1 loop and the V2 proxy branch (lines 606–1023)

These blocks must survive a V1 retirement unchanged: the V2 branch is deliberately placed after them
(comment at 972–985: "the user turn is already persisted, the regenerate/resend rerun is already planned,
and replayHistory already inlines document-attachment text").

| Lines | Block | Side effects |
|---|---|---|
| 606–607 | `ensureConversation`, `extractStreamControl` (#trace / page-write / clean content) | read |
| 609–616 | Compliance pre-screen `screenComplianceRisk` (log-only) | log |
| 618–681 | `mode==='new'`: body validation, `MAX_ATTACHMENTS_PER_MESSAGE`, attachment lookup + `assertAttachmentConversation` + `validateVisionSet`, **user `clio_messages` row**, attachment claim (`clio_attachments.messageId`) in one tx | **DB write** |
| 682–712 | `regenerate`/`resend`: `planTurnRerun` → update last user body / delete trailing assistant rows | **DB write** |
| 714 | SSE `turn_accepted` | stream |
| 723 | `assistantMessageId` carrier for the final `done` frame (Phase 27 P1) | — |
| 734–782 | Deterministic compliance BLOCK (`screenComplianceBlock`; env `MERI_COMPLIANCE_BLOCK`, tenant flag `complianceBlock`) → refusal text + **assistant row `servedBy:'compliance-block'`** + `done` | **DB write**, early return |
| 784–819 | History load with compaction boundary (`summaryUpToMessageId`, `take: 80`) | read |
| 821–892 | Attachment replay: document text re-injection, current-turn images (`currentTurnImages`), filing references, `compactedAttachmentContext` | read (`clio_attachments.data` bytes) |
| 894–970 | Deep-Research promote gate (`detectDeliverableReportRequest`; env `MERI_RESEARCH_PROMOTE`, tenant flag `deepResearchPromote`) → offer text + `research_offer` frame + **assistant row `servedBy:'research-promote'`** + `done` | **DB write**, early return |
| 986–1023 | V2 gate evaluation (`isMeriV2SurfaceEnabled` only when bearer ∧ configured) and dispatch | — |

### 2.2 V1-only loop body (lines 1025–2149) — the retirement candidate

| Lines | Branch / capability | Notes |
|---|---|---|
| 1026 | `classifyIntent` (intent model call) | V1-only model call |
| 1029–1036 | Firm skills by **intent or trigger phrase** (`matchFirmSkillForTurn(intent, …)`) | intent-triggered skills exist only here |
| 1038–1056 | `orchestrateContext` (pre-warm sources, policy tier, template, active client, conflict) → `buildSystemBlocks` | **patched at construction by `installRawPhase19Adapters`** to consume the governed Context Plane packet |
| 1058–1092 | SSE `start{intent,tier}`, `plan` (`buildPlanSteps`), `page_write` note, `trace`, `sources`, `conflict`, `template` | `plan`/`trace`/`conflict`/`template` frames are V1-only |
| 1094–1097 | `trimHistoryToBudget` (`CLIO_HISTORY_CHAR_BUDGET`) | V1-only |
| 1099–1169 | Turn accumulators: artifacts, toolsUsed, actionsTaken, usage, citations, `groundingByN`, auditor `ledgerEntries`, page-write payload, trace rounds, `trustStepsForHistory` | — |
| 1172–1232 | BYOK `aiCredentials.resolveProvider`, model choice (`CLIO_MODEL` unless tenant override), extended-thinking params (`CLIO_EXTENDED_THINKING`, `CLIO_THINKING_MODE`, `CLIO_THINKING_BUDGET_TOKENS`), timeouts/budgets (`CLIO_REQUEST_TIMEOUT_MS`, `CLIO_MAX_TOOL_ROUNDS`, `CLIO_TURN_BUDGET_MS`, `CLIO_TOOL_TIMEOUT_MS`, `CLIO_TOOL_RETRIES`), tool schema assembly: native **read-only** tools (side-effecting filtered out, `run_analysis` gate) + **bridged MCP schemas** (`mcp.bridgedSchemasFor`) + prompt-cache control | V1 is READ-ONLY by design (no B1–B4 approval gate) |
| 1234–1256 | Anthropic message array from history; current-turn images as native vision blocks | — |
| 1258–1292 | Round loop: `loopBudgetExceeded` (round cap / wall clock) with user-visible wrap-up notes; client abort; per-call `AbortController` timer | — |
| 1302–1395 | Direct `fetch('https://api.anthropic.com/v1/messages')` streaming; SSE `thinking` relay; text deltas; tool_use accumulation; `message_delta` stop reason/details; in-band provider error → throw | V1 calls Anthropic directly (no orchestrator) |
| 1397–1438 | Usage accumulation; stop-reason handling: `refusal` (user-visible message), `max_tokens` (truncation notice), `pause_turn` (warn) | V1-only user-visible notices |
| 1440–1478 | Turn-complete check; assistant turn reconstruction incl. `thinkingReplayBlocks` | — |
| 1480–1562 | Tool preparation: parse inputs, **client-scope ENFORCEMENT** (2026-07-29: a different `clientId` is refused, name→id resolution for the session client), `conversationId` threading for artifact tools, SSE `tool_call` with redacted input, concurrency classification (bridged read-only allowlist) | scope rule is V1-in-process |
| 1564–1630 | `runToolsConcurrently` (read-only parallel / side-effecting serialized, per-tool timeout, retries + backoff), per-`tenant:tool` **circuit breaker**, scope-refusal short-circuit, bridged MCP dispatch, **side-effect refusal** (defense in depth), action audit log | V1-only resilience semantics |
| 1632–1743 | Tool results: artifact capture (`extractToolArtifacts`), page-write payload capture, injection-neutralizing framing (`sanitizeToolResultText`), FORM A citation extraction + grounding capture, SSE `sources`, `trustStepsForHistory`, auditor ledger entries, `tool_result` blocks, per-round trace | — |
| 1746–1757 | Error path: abort vs failure (`error` frame, `Error:` body) | — |
| 1759–1786 | Total usage log line **`Meri total usage [conv …]`** (V1-only log signature, see §6), SSE `usage`, **`recordAiUsageEvent('clio_chat')`** | **DB write** (`ai_usage_event`) |
| 1788–1823 | FORM A `validateCitationMarkers` (+ `citations` frame); FORM B `validateFormBCitations` strip for persisted history | — |
| 1825–1917 | Post-hoc grounding auditor (`MERI_AUDITOR_MODE`; chat observe-only per ADR-2) → **`meri_audit_ledger` row**, SSE `grounding_caveat` under enforce/annotate | **DB write** |
| 1919–1948 | Deliverable verifier (`verifyDeliverable`) + structural/fan-out enrichment → SSE `verification` | model call |
| 1950–1965 | Real `page_write` payload frame; `grounding_statement` frame | `grounding_statement` is V1-only |
| 1967–1981 | Execution trace summary (`summarizeTurnTrace`) → log + optional `exec_trace` | — |
| 1983–1995 | `generateSuggestions` → `suggestions` frame | model call |
| 1997–2009 | Finish receipt: `finishReason` ∈ aborted/error/loopStop/stop/provider/stream_interrupted, `partial` | V1-only richness |
| 2011–2085 | **Assistant `clio_messages` row** with metadata {intent, model, tier, preWarmSources, toolsUsed, usage, citations, groundingStatement, groundingCaveat, finishReason, partial, verification, trace, suggestions, actions, plan, trustSteps, compliance} + **`clio_artifacts` rows** for produced artifacts | **DB write** — note: no `servedBy` key (V2 writes `servedBy:'meriv2'`) |
| 2087–2091 | SSE `artifact` frames | stream |
| 2093–2118 | **Claim/Evidence store** first writer (`claimWriter.persistClaimsSafe`) from verifier claims | **DB write**, fire-and-forget |
| 2120–2138 | Autolearn (`maybeLearnFromConversation`, skipped when auditor flagged) | **DB write** (clio_memory), async |
| 2140–2144 | `scheduleAfterTurnMaintenance` (search indexing + compaction) | **DB write**, async |
| 2146–2148 | Final `done{finishReason, partial, messageId}` | stream |

### 2.3 The V2 proxy branch in apps/api (`streamMessageViaMeriV2`, lines 2164–2616)

What apps/api still does around the orchestrator call on the V2 path (this is what a V1 retirement must
NOT remove, and what the orchestrator does NOT do itself):

| Lines | apps/api responsibility on the V2 path |
|---|---|
| 2187–2192 | BYOK credential resolution, forwarded per invocation |
| 2199–2210 | `clio_memory` recall pre-warm → `memoryContext` (suppressed while a governed turn is active, via the Phase-19 adapter) |
| 2215–2221 | Client-KB snapshot → `clientKbSnapshot` (also suppressed under Phase 19) |
| 2228–2237 | Firm-skill addendum, **phrase-triggered only** (intent passed as `''`) |
| 2239–2249 | `start{intent:'general',tier:'fast'}` + page-write note |
| 2276–2387 | Event translation: `tool_call`, `tool_done→sources`, `pending_approval` (full proposal shape), `artifact`, `text`, `page_write`, `grounding_caveat`; `start` swallowed; `done`/`error` captured |
| 2389–2420 | `meriV2Chat.streamChat` (→ `POST ${MERIV2_ORCHESTRATOR_URL}/meri-api/chat/stream`); no silent fallback to V1 on failure |
| 2441–2454 | Reply/`usage`/`citations` frames from the orchestrator `done` frame |
| 2456–2485 | Deliverable verification + structural enrichment (same verifier as V1) |
| 2487–2499 | `exec_trace` from collected steps |
| 2508–2523 | Suggestions |
| 2530–2594 | **Assistant `clio_messages` row** (`servedBy:'meriv2'`, `model:'meriv2-orchestrator'`, `tier:'fast'`, trustSteps, pendingApprovals, actions) + artifact→message linkage |
| 2596–2609 | Autolearn + after-turn maintenance |
| 2611–2615 | `error` or `done{messageId}` |

## 3. Branch-by-branch inventory: V1 capability → V2 equivalent → status

Legend — **Parity**: same outcome on the V2 path. **Shared**: runs in apps/api before/after the branch, so
V2 turns already get it. **Partial**: exists but differs materially. **GAP**: V1 does it, nothing on the
V2 path does. **By design**: intentionally different. Orchestrator paths are relative to
`apps/meriv2-orchestrator/src/meri/`.

| # | V1 capability (meri.service.ts) | V2-path equivalent | Status | Notes / gap detail |
|---|---|---|---|---|
| 1 | Attachment validation, claim, document-text replay (618–681, 821–892) | Shared prelude; orchestrator receives pre-flattened `messages` text; `save_chat_attachments` is a delegated write tool | **Shared** | Orchestrator has no attachment concept (`chat/chat-prompt.ts` `ChatInput`); it never reads `clio_attachments`. |
| 2 | Vision — current-turn images as native blocks (836–870, 1245–1255) | `chat/chat-assistant.service.ts:148-160` prepends base64 image blocks; input via `ChatInput.currentTurnImages` | **Parity** | `filename` dropped in transit (2401–2406). Anthropic-only by design. |
| 3 | Compliance pre-screen (609) and deterministic BLOCK (734–782) | Shared prelude (block short-circuits before the branch) | **Shared** | Orchestrator never sees blocked asks. |
| 4 | Compliance/approval persistence — V1 has none (read-only loop) | Orchestrator `invokeTool` write branch (`chat-assistant.service.ts:733-829`) → `POST /api/clio/action-proposals` (`api-action-proposal.repo.ts:86`); apps/api `MeriActionProposalService.recordDecisionInTx` writes `complianceCheck` + policy decision | **By design (V2 ⊃ V1)** | V2 can perform gated writes; V1 refuses all writes. `ApiComplianceAuditRepo` (`POST /api/clio/compliance-checks`) is injected but never called from the chat loop (dead wiring). `approvals/check` + `pending-actions` routes are intentionally kept mounted returning 410 (spec-pinned). |
| 5 | Deep-Research promote gate (894–970) | Shared prelude (fires before the branch; new turns only) | **Shared** | Orchestrator has no research promotion; research runs live in the V3 path only. |
| 6 | Page-write note + payload from `draft_policy_memo`/`create_meeting_brief` (1068–1076, 1644–1650, 1952–1956) | Note emitted by apps/api (2243–2249); payload captured orchestrator-side (`chat-assistant.service.ts:522-528`, `finalize` L373-380) and forwarded (2360–2369) | **Parity** | Suppressed orchestrator-side when the release gate holds. |
| 7 | Rerun modes regenerate/resend (682–712) | Shared prelude | **Shared** | Orchestrator is stateless per turn; receives the resulting history (last-30 slice, `chat-assistant.service.ts:114-119`). |
| 8 | History + compaction-summary consumption (784–819) | Shared prelude; summary forwarded as `ChatInput.conversationSummary` | **Shared** | Compaction is *produced* only by apps/api after-turn maintenance (both paths). |
| 9 | Memory recall `loadRelevantMemories` (via `orchestrateContext`) | Pre-warmed in apps/api (2199–2210) → `memoryContext` | **Parity** | Both suppressed while a governed turn is active (Phase-19 adapters in `meriv3-runtime.proxy.ts`), so memory reaches the model via the governed packet on both runtimes. |
| 10 | Client-KB snapshot (via `orchestrateContext`) | Pre-warmed in apps/api (2215–2221) | **Parity** | Same Phase-19 suppression. |
| 11 | Firm skills by intent **or** phrase (1029–1036) | Phrase-only addendum (2228–2237) → `ChatInput.skillAddendum` | **Partial** | Intent-triggered firm skills cannot fire on V2 (documented at 2224–2230). |
| 12 | `classifyIntent` + policy tier + `templateForIntent` (1026, 1038–1056) | Orchestrator plan-mode intent returned in the `done` frame (`resolvedIntent`, 2430); no tier/template concept | **Partial** | Persisted `tier` is hard-coded `'fast'`; `template`/`conflict`/`trace{policy}` frames never emitted on V2. |
| 13 | `orchestrateContext` / Context Plane packet (1038) | Orchestrator requires `governedContext` (400 `meri_governed_context_required`, `chat/chat.controller.ts:135-143`); packet injected by the apps/api runtime Proxy (`governedStreamClientProxy`) | **Parity (Phase 19)** | Orchestrator-side chat context is identity-only (`meri-context.resolver.ts resolveIdentity`); firm/client context arrives inside the governed prompt. Typing gap: `MeriV2ChatClient.streamChat` input does not declare `governedContext` — only the Proxy adds it. |
| 14 | Native read-only tool surface, side-effect refusal (1218–1227, 1594–1600) | Full-chat catalog incl. write tools behind action proposals (`meri-registry.service.ts:82-122`) | **By design** | Retiring V1 removes the "read-only fallback" behavior class entirely. |
| 15 | Bridged MCP tools (1228, 1587–1589) | None on the V2 chat path (MCP exists only in V3: `meriv3/api-managed-mcp.repo.ts`) | **GAP** | V2 turns lose third-party MCP tools that V1 (and V3) expose. |
| 16 | Client-scope enforcement on tool inputs (1503–1535) | Delegated tools execute via `POST /api/clio/tools/:name` (`api-tool-executor.repo.ts:104`) | **Open question** | Whether the tools endpoint enforces the 2026-07-29 "different clientId is refused" rule for orchestrator-originated calls was not verified here. Must be confirmed before retirement. |
| 17 | `conversationId` threading for artifact-producing tools (1543–1545) | Orchestrator threads `conversationId` (artifacts are created by delegated `create_*` tools; linkage at 2581–2591) | **Parity** | — |
| 18 | Per-tool timeout, retries + backoff, per-tenant circuit breaker, concurrency classes (1564–1620) | `MERIV2_TOOL_TIMEOUT_MS` only (`api-tool-executor.repo.ts:87`); `invokeTool` passes no `ToolExecutionControl`, so the turn abort never reaches a running tool; action-proposal POST has no timeout | **Partial** | Different resilience semantics; not a feature gap but a behavior difference to accept explicitly. |
| 19 | Extended thinking relay (`thinking` frames, 1347–1355, 1460–1462) | None (no thinking in `chat-assistant.service.ts`) | **GAP** | V1-only UX. |
| 20 | Round cap / wall-clock budget with user-visible wrap-up (1258–1280) | `MAX_ROUNDS` 14, per-call `MERIV2_TIMEOUT_MS` (live 170000 ms); no whole-turn budget | **Partial** | — |
| 21 | Stop-reason notices: refusal text, max_tokens truncation notice, pause_turn warn (1410–1438) | Apology string on model failure (`chat-assistant.service.ts:422`) | **Partial** | V1's user-facing truncation/refusal notices have no V2 analogue. |
| 22 | Tool-result injection framing (1655–1666) | Orchestrator wraps tool results as untrusted data (V1 comment cites parity with the orchestrator) | **Parity** | — |
| 23 | FORM A citation extraction + marker validation (1667–1681, 1788–1802) | `chat-assistant.service.ts:253,530` (`validateCitationMarkers`, `extractCitationsFromToolResult`); citations returned in `done` and re-emitted by apps/api (2453) | **Parity** | — |
| 24 | FORM B citation strip for persisted history (1814–1823) | `chat-assistant.service.ts:254` (`validateFormBCitations` over the tool-result ledger, after FORM A at :253) | **Parity** | Strip happens orchestrator-side before the reply reaches apps/api, so the persisted V2 body is already sanitized. |
| 25 | Post-hoc grounding auditor + `meri_audit_ledger` + `grounding_caveat` (1825–1917) | `auditChatReply` L567-587 + `persistChatAudit` L589-620 (`meriAuditLedger.create`) orchestrator-side; caveat forwarded (2370–2379) | **Parity** | Ledger row is written by the orchestrator process instead of apps/api. |
| 26 | Release gate (`MERI_RELEASE_GATE`) — V1 has none for chat | `resolveAssuranceRolloutMode` + pre-release and pre-persist gates (`chat-assistant.service.ts:136-146, 189-250, 284-371`) | **By design (V2 ⊃ V1)** | Live: api `MERI_RELEASE_GATE=enforce`, orch `shadow`. |
| 27 | Deliverable verifier + structural enrichment → `verification` (1919–1948) | apps/api on the V2 path (2456–2485) | **Parity** | — |
| 28 | `grounding_statement` frame + persisted `groundingStatement` (1958–1965, 2036) | None | **GAP** | Web renders it when present; V2 turns never carry it. |
| 29 | `plan` frame + persisted `metadata.plan` (1066–1067, 2051) | None ("no plan concept in the MeriV2 orchestrator loop", 2556–2560) | **GAP** | Acknowledged product gap. |
| 30 | Execution trace / `exec_trace` (1967–1981) | Steps-derived trace (2487–2499) | **Partial** | Different shape (no per-round usage/timings). |
| 31 | Suggestions (1983–1995) | apps/api (2508–2523) | **Parity** | — |
| 32 | AI usage metering `recordAiUsageEvent('clio_chat')` (1770–1786) | Orchestrator meters itself (`chat-assistant.service.ts:554`, `meterRound`) | **Parity (different writer)** | Confirm the surface label the orchestrator records matches the dashboards that read `'clio_chat'`. |
| 33 | Finish receipt `finishReason` + `partial` (1997–2009, 2040–2041) | `finishReason` ∈ aborted/error/stop only; no `partial` | **Partial** | History replay consumers that read `partial` see it only on V1 rows. |
| 34 | Assistant row + artifact rows (2011–2085) | apps/api (2530–2594) | **Parity** | Metadata differences: V2 adds `servedBy`, hard-codes `model`/`tier`; V1 lacks `servedBy` (see §6). |
| 35 | Claim/Evidence store writer `persistClaimsSafe` (2093–2118) | None on the V2 path (the orchestrator's `/api/clio/claims` call exists only in the in-editor assistant) | **GAP** | Grounding-audit tables receive no chat claims from V2 turns. |
| 36 | Autolearn (2120–2138) | apps/api (2596–2608) | **Parity** | — |
| 37 | After-turn maintenance: search index + compaction (2140–2144) | apps/api (2609) via `MERI_TURN_MAINTENANCE` (bound to `RAW_MERI_SERVICE`) | **Parity** | Retirement must keep `afterTurnMaintenance` and its DI binding. |
| 38 | Abort / client disconnect handling (1281–1292, 1746–1750) | Orchestrator checks the signal between rounds (`chat.controller.ts:79-80`); apps/api forwards `clientSignal` | **Partial** | Abort does not interrupt a running tool batch on V2. |
| 39 | Direct Anthropic call from apps/api (1302–1320) | Orchestrator process owns all model calls | **By design** | **Availability consequence:** V1 is the only runtime that can answer while `apps/meriv2-orchestrator` is down; V3 also lives in that process. |

### 3.1 SSE frame vocabulary

| Frame | V1 loop | V2 path (apps/api translation) |
|---|---|---|
| `turn_accepted`, `research_offer` | prelude | prelude (shared) |
| `start`, `text`, `tool_call`, `sources`, `artifact`, `page_write`, `usage`, `citations`, `verification`, `exec_trace`, `suggestions`, `grounding_caveat`, `error`, `done` | yes | yes |
| `pending_approval` | never | yes (V2-only) |
| `plan`, `trace`, `conflict`, `template`, `thinking`, `grounding_statement` | yes | **never** |

## 4. Gap list (V1 does it; nothing on the V2 path does), in suggested priority order

1. **`plan` frame / `metadata.plan`** (#29) — visible in the session rail for V1 rows only.
2. **`grounding_statement`** (#28) — trust UI element missing on V2 turns.
3. **Claim/Evidence store persistence for chat** (#35) — audit tables silently stop receiving chat claims.
4. **Bridged MCP tools on V2 chat** (#15) — functional loss for tenants with MCP servers (V3 has them).
5. **Extended-thinking relay** (#19) — UX only.
6. **Intent-triggered firm skills** (#11) — partial.
7. **Refusal / max_tokens / budget notices** (#21, #20) — user-facing honesty about truncation.
8. **`partial` receipt + rich `finishReason`** (#33).
9. **Open verifications:** client-scope enforcement on delegated tools (#16), usage-metering surface label (#32).

Because every live tenant is on **V3** today, the operative question for users is V3-vs-V1 parity, not
V2-vs-V1. This document scopes V2 because V2 is the code-level fallback the V1 gate hands turns to; a V3
parity inventory should be produced before Phase R2 below.

## 5. The token-less-caller question — who can reach V1 without a bearer?

**Nobody over HTTP.** Verified chain:

| Fact | Evidence |
|---|---|
| Every `/api/clio/*` request must carry `Authorization: Bearer <Clerk JWT>`; otherwise 401 | `apps/api/src/tenant/tenant-context.middleware.ts:112-114` (`Missing bearer token`), then `verifySessionToken` at :120; applied `forRoutes('*')` in `apps/api/src/app.module.ts:137-153` |
| No bypass entry covers the stream route | Bypass list `tenant-context.middleware.ts:80-102` (`/webhooks/clerk`, `/api/v1/demo-requests`, OAuth callbacks, `/api/clio/runtime` [no such controller — dead entry], `/api/clio/mcp-oauth/callback`, `/api/insights`, `/api/internal`) |
| No cookie, query-param, API-key or service-secret authentication exists for this route | `INTERNAL_SERVICE_SECRET` guard is used only by `internal/*` controllers; `x-internal-service-secret` on `POST clio/tools/:name` / action-proposals is an *additional* proof ("User authentication remains mandatory", `tool-service-secret.guard.ts:22-26`); no `@Public`-style decorator exists in `apps/api/src` |
| The controller's capture is looser than the middleware's check, so any authenticated request yields a non-empty `bearerToken` | `meri.controller.ts:311-312` vs middleware `startsWith('bearer ')` *(inferred from the two regexes)* |
| Only two call sites exist in the repo | `apps/web/src/components/chat/useMeriChatController.ts:2032` (shared by ChatDrawer, MeriOverlay and vNext `VNextMeriWorkspace`) and `apps/api/scripts/smoke-clio-tooluse.ts:51` (always sets the bearer, exits without `CLIO_SMOKE_TOKEN`) |
| The web header is conditional (`...(token ? { Authorization } : {})`, `useMeriChatController.ts:602-609`) — but a null Clerk token yields a 401 at the edge, never a bearer-less turn inside the service | same |
| The orchestrator never calls the stream route; api-strategy, workspace, engagement-api, intel-api, defense-api have no references; no e2e test hits it | repo-wide grep for `clio/conversations`, `/stream`, `streamMessage` |
| The V3 branch also hard-fails without a bearer | `meriv3-proxy.service.ts:98-106` ("MeriV3 could not authenticate this turn") |

Consequences for the retirement plan:

- The `bearerToken &&` arm of `shouldRouteMeriV2FullChat` is exercised only by in-process unit specs
  (`meri-turn-lifecycle.phase4.spec.ts`, `meriv3-proxy.service.spec.ts`, `meriv3-runtime.proxy.spec.ts`).
  Keep it (it is cheap defense in depth and now pinned), but no "token-less V1 behavior" needs preserving for users.
- The **live** reasons a turn can reach V1 are: impersonation (containment, 264b351af), an explicit
  `meriv2.fullChat=false`, `MERIV2_ENABLED` off, or `MERIV2_ORCHESTRATOR_URL` unset — and only after the
  V3 gate has declined (today: never, for the 9 live tenants).
- A stale comment remains at `meri.service.ts:600-604` (the `impersonateTenantId` parameter doc: "the
  controller withholds the bearer on impersonated turns"). The controller stopped withholding it in
  3e2a9b42f; containment now lives in the routing helper. The conclusion (impersonated turns route legacy
  when V3 declines) is still right, the mechanism described is not. Comment-only follow-up; not changed here.

## 6. Reachability today and under each rollback (how to prove V1 is dead before deleting it)

| Scenario | Bearer browser turn | Impersonated turn (capiro_admin) |
|---|---|---|
| **Live now** (V3 keys open on all 9 tenants) | V3 | V3 (gate is impersonation-blind; ctx is the middleware-swapped tenant) |
| `MERIV3_ENABLED` removed (or dropped by a `cdk deploy`) | V2 | **V1** |
| Tenant removed from `MERIV3_CANARY_TENANT_SLUGS` or `meriv3.fullChat=false` | V2 | **V1** |
| New tenant not in the cohort | V2 | **V1** |
| `MERIV2_ENABLED` off / orchestrator unconfigured, V3 also closed | **V1** | **V1** |
| Orchestrator process down, gates unchanged | V3 error (no fallback) | V3 error |

Zero-code detectors for "did V1 serve any turn in window W":

- CloudWatch (api log group): the info line **`Meri total usage [conv `** (line 1759–1762) is emitted only by
  the V1 loop. `aws logs filter-log-events --filter-pattern '"Meri total usage"'` over W with zero hits ⇒ zero V1
  turns. (Read-only.)
- Database: `clio_messages` assistant rows carry `metadata.servedBy` = `'meriv2'` (V2, meri.service.ts:2547),
  `'meriv3'` (V3, meriv3-proxy.service.ts:503), `'compliance-block'`, `'research-promote'`; V1 rows carry
  **no `servedBy`** and have `metadata.tier` from the policy and a real Anthropic `model` id.
  `SELECT count(*) FROM clio_messages WHERE role='assistant' AND created_at > … AND
  metadata->>'servedBy' IS NULL AND metadata ? 'plan'` isolates V1 rows *(inferred from the metadata shapes;
  not executed)*.
- Recommended first PR of the project: add `servedBy: 'legacy-v1'` to the V1 assistant metadata so the DB
  detector becomes exact. (One-line, zero behavior change beyond metadata.)

## 7. Retirement prerequisites and phased plan (proposal — nothing here is executed)

| Phase | Deliverable | Gate to proceed | Risk |
|---|---|---|---|
| **R0 — Pin + observe** | Truth-table specs (this PR); `servedBy:'legacy-v1'` metadata; CloudWatch/DB detectors from §6 run weekly | ≥ 4 weeks with zero V1 turns **including** at least one impersonation session on a cohort tenant | low |
| **R1 — Impersonation decision** | Either (a) lift Phase-0 containment by carrying one unified effective actor/tenant/impersonation context end-to-end so impersonated turns may enter V2, or (b) declare V3 the permanent impersonation carrier and add an explicit refusal when V3 declines an impersonated turn | Decision recorded (ADR); spec `meriv2-routing.helpers.spec.ts` + the matrix spec updated **deliberately** if (a) | medium — this is a routing contract change |
| **R2 — Close or accept gaps** | Items 1–8 of §4 either implemented on V2/V3 or explicitly accepted; open verifications (#16, #32) closed; **V3-vs-V1 parity inventory** produced | Product sign-off | medium |
| **R3 — Explicit no-runtime path** | Replace the V1 loop entry (line 1025) with a classified refusal (`error` frame + persisted assistant row) when both V3 and V2 decline; keep the shared prelude (§2.1) and the V2 branch (§2.3) intact; decide the orchestrator-outage stance (V1 was the last in-process runtime) | Focused jest + tsc; canary on capiro-internal with V3 key closed | **high** — persistence and SSE contract |
| **R4 — Delete the loop** | Remove lines 1025–2149 and V1-only private helpers once no other caller remains (`classifyIntent`, `orchestrateContext`, `buildSystemBlocks`, `composeSystemParts`, `policyForIntent`, `templateForIntent`, `trimHistoryToBudget`, tool-loop helpers, breaker, `recordAiUsageEvent('clio_chat')`, `persistClaimsSafe`) | **B4 proxy simplification must land first or together**: `installRawPhase19Adapters` monkey-patches `orchestrateContext`, `loadRelevantMemories`, `policyForIntent`, `templateForIntent`, `meriV2Chat`, `clientKb` on the raw service — deleting those seams breaks the patch at construction | **high** |
| **R5 — Config + docs cleanup** | Remove V1-only config keys after confirming no other reader: `CLIO_MAX_TOOL_ROUNDS`, `CLIO_TURN_BUDGET_MS`, `CLIO_TOOL_TIMEOUT_MS`, `CLIO_TOOL_RETRIES`, `CLIO_EXTENDED_THINKING`, `CLIO_THINKING_MODE`, `CLIO_THINKING_BUDGET_TOKENS`, `CLIO_REQUEST_TIMEOUT_MS`, `CLIO_HISTORY_CHAR_BUDGET` (verify each); update `meri.controller.ts` / `meri.service.ts` comments that still describe the legacy path; DRIFT-FINDINGS entry for any task-def env removed | tsc across apps; config-schema spec | low |

Each phase is its own PR with the PR #1688 discipline (worktree on fresh main, zero-overlap proof, api tsc +
focused jest + baseline A/B for anything red, evidence table in the PR body, merge only on explicit authorization).

## 8. Explicitly out of scope for this document

- Any code change in `meri.service.ts`, `meri.controller.ts`, `meriv3-runtime.proxy.ts` beyond the
  comment-only live-state annotation shipped alongside it.
- B4 proxy simplification (the Phase-19 adapter installers) — referenced only as an R4 dependency.
- The retired approval routes (`approvals/check`, `pending-actions`, kept mounted returning 410) and the legacy
  web route guards (`apps/web/src/components/chat/meri-route-guards.ts`) — intentionally kept.
- V3 parity with V1 — flagged in §4 as a prerequisite inventory, not produced here.
