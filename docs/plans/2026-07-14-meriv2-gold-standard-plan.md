# MeriV2 Gold-Standard Plan — retire the legacy chat loop

Date: 2026-07-14
Status: plan (no code changes in this doc)
Inputs: full MeriV2 audit (M1–M6 + BYOK deploy gaps, 2026-07-14), Meri-conversation
root-cause analysis (2026-07-14), 4-area gap inventory with adversarial verification
(2026-07-14, workflow `meriv2-gold-standard-gaps`), 2026-07-05 migration-readiness
report. Every file:line below was verified against `origin/main` @ `52a7988`.

---

## 0. The reframe that shrinks this plan

"Legacy is going away" does NOT mean apps/api is going away. Verified coupling
analysis shows the legacy system decomposes into two very different halves:

**A. The legacy chat TURN LOOP** — `MeriService.streamMessage`'s in-process branch
(meri.service.ts:~660 onward), reachable only via `POST /clio/conversations/:id/stream`.
THIS is what retires.

**B. The apps/api data/tool plane** — `MeriToolsService` (68 tools), Deep Research
(`MeriResearchService`, own Anthropic loop, meri-research.service.ts:249), the
scheduled-task runner (run-clio-scheduled-tasks.ts:93, own loop), proactive-alert
emission (emit-clio-alerts.ts, cron), attachments upload/extract, artifact
versioning/export/image endpoints, memory CRUD (/clio/memory/*), MCP server
CRUD/OAuth, firm-skill CRUD. **None of these execute through the turn loop**
(verified: MeriToolsService has zero MeriService dependency; research/schedules
run their own loops). MeriV2 *itself* depends on this plane — every delegated
tool call goes to `POST /api/clio/tools/:name`. **This half stays, permanently.**

Also staying: the apps/api **proxy adapter** (`streamMessageViaMeriV2`,
meri.service.ts:1518) — the SSE translation layer between the frontend's
`/api/clio/*` contract and the orchestrator. Retirement = delete the legacy
in-process branch; the proxy branch becomes THE path. (Preserves the frontend
contract per DECISIONS D2 — no web repoint needed.)

**Definition of Done**
1. 100% of chat turns served via MeriV2 (routing gate at meri.service.ts:640-646
   deleted; page-write, vision, impersonation all served or explicitly dropped).
2. Context + UX parity: roster/memory/skills/summary injected; citations,
   verification, suggestions, thinking, usage, trace SSE frames restored.
3. Safety actually on: M1 approval fix shipped; auditor ≥ shadow on chat;
   BYOK operational end-to-end (H1/H2).
4. Live both-path parity gate (M5) run green per surface before each gate removal.
5. Infra truth: M3 headers, M4 intel-api in IaC + built from main, M6 ALB codified.
6. Legacy in-process branch + dead code deleted after a full rollback window;
   subsystems in (B) confirmed keep-in-api.

---

## 1. What is ALREADY at parity (verified — do not rebuild)

| Capability | Evidence |
|---|---|
| Grounding kernel (closed-world, citation grammar, refusal) | byte-identical — meriv2-core re-exports from @capiro/shared (domain-primer.ts:39-48) |
| Firm identity + user voice standing context | ContextCompiler layers ['firm-identity','user-voice'] (meri-context.resolver.ts:45-57) |
| clio_memory recall | proxy pre-warms `dto.memoryContext` via the SAME loadRelevantMemories (meri.service.ts:1542-1548→1652); self-serve via search_memory (reads memory_items projection of save_memory writes) |
| Write-tool safety | PolicyApprovalGate PASS/WARN/BLOCK, fail-closed, live approval UX (ChatDrawer + /clio/approvals/approve) — STRONGER than legacy's post-hoc audit |
| Artifacts (docs, memos, run_analysis charts) | delegated create_* persist ClioArtifact; artifact SSE frame + GET /clio/artifacts/:id/image work end-to-end (chat-assistant.service.ts:489-517; meri.service.ts:1726-1737) |
| Document-text attachments in history | replayHistory inlined text passes through verbatim |
| BYOK (code level) | RequestScopedLlmClient per-request tenant credential; CI guard on stray key reads |
| Tool surface | full 68-tool delegated catalog incl. list_members + subcommittee resolution (PRs #475/#476, live) |

---

## 2. Wave 0 — Safety & ops hardening (independent; start immediately)

| # | Item | Detail | Effort |
|---|---|---|---|
| 0.1 | **M1: gate create_task/update_task as WARN** | Verified spec: remove both from `internal_artifacts.pass` includes (compliance-rules.ts:141-142, BY NAME not line), add `crm_task.requires_approval` WARN rule (tier high, code crm_mutation), update spec + stale comments in meri-registry.service.ts:52-61/83-90. Approval-granting UX confirmed to exist (useMeriChatController.ts:1117). Flips live GA behavior → needs sign-off. | S |
| 0.2 | **H1: wire INTERNAL_SERVICE_SECRET into intel-api task defs** | Hearing BYOK is code-complete but resolver silently degrades to global key without it. Out-of-band task-def edit (jq recipe per CDK-drift gotcha), then roll intel-api. | S |
| 0.3 | **H2: orchestrator ANTHROPIC_API_KEY into CDK** | Today only in hand-authored `infra/deploy/meriv2-orchestrator-taskdef.with-anthropic.json`; a `cdk deploy` would ship the orchestrator keyless. Add to `meriv2OrchestratorServeSecrets` (gated fromSecretCompleteArn pattern). | S |
| 0.4 | **M2 safe wiring: auditor to shadow** | Set `MERI_AUDITOR_MODE=shadow` on the orchestrator + api task defs (pure/deterministic, decision is `deliver` for every surface in shadow — cannot alter output; verify meri_audit_ledger write volume). Optionally add shadow skeptic-audit inside auditReplyShadow behind default-off `MERI_CHAT_SKEPTIC_MODE` (fail-open by construction, N≤5 LLM calls/turn cost). | S |
| 0.5 | **M3: truth-up RLS "DO NOT MERGE" headers** | Replace stale HOLD headers in the two applied intel-api migrations (comment-only; accept the `migrate status` "modified" advisory) + fix hearing-tenant-scoping.spec.ts stale comment. SEPARATE ACTION: verify enable-feature admin path (entrypoint.sh:89-92 raw INSERT into FORCE-RLS intel_feature_flag) works — needs BYPASSRLS or `SET app.bypass_rls`. | S |
| 0.6 | **M6: codify prod ALB rules** | LIVE-VERIFIED: `/meri-api/*`@13→capiro-prod-meriv2-orch-tg, `/intel-api/*`@14, `/webhooks/*`@15. Add `scripts/meri-alb-rules.sh` (mirror onboard-alb-rules.sh) + runbook with these values; fix the CDK comment's impossible 34-char TG name and the meri=15 doc family. | S |
| 0.7 | **M5: land the parity workflow** | `.github/workflows/meriv2-parity.yml` (workflow_dispatch; operator pastes fresh Clerk JWT + client id; workspace-gen mutating case opt-in; nightly commented until token-minting exists) + parity README runbook. Target stack decision needed (staging is being decommissioned → prod internal tenant, in-editor case is non-mutating). | S |

## 3. Wave 1 — Affordance & context parity on the MeriV2 path (biggest UX payback)

Two sub-tracks; most of 1A lives in the **proxy** (apps/api), which survives forever.

**1A — Proxy-side SSE/metadata restoration** (turns already routed to MeriV2 today
silently lose these):
| # | Item | Shape | Effort |
|---|---|---|---|
| 1A.1 | Suggestions frame | call existing generateSuggestions over accumulated reply in streamMessageViaMeriV2; emit + persist (today hardcoded `[]`, meri.service.ts:1707) | S |
| 1A.2 | Usage aggregate | orchestrator done frame carries usage (metering already recorded per-round, chat-assistant.service.ts:228-240); proxy emits + persists (today `{}` at 1703) | S |
| 1A.3 | trace/exec_trace | #trace turns route to MeriV2 TODAY and silently lose frames (traceEnabled not in the routing gate); done-frame per-round trace + proxy emit | S |
| 1A.4 | Metadata fidelity | surface real intent/mode + preWarmSources instead of hardcoded 'general'/'fast'/[] (meri.service.ts:1550, 1697-1701) | S |
| 1A.5 | Verification/confidence frame | run apps/api's verifyDeliverable/enrichDeliverableStructural in the proxy post-stream; emit + persist + persistClaimsSafe. (Verifier logic ALSO exists in meriv2-core and is already wired on in-editor — chat just never calls it; proxy-side reuse is cheapest.) | M |
| 1A.6 | Conversation summary/compaction | forward conversationSummary (already computed upstream at meri.service.ts:551) as a ChatInput field; prepend in buildChatSystemPrompt. Today long threads silently drop turns beyond last-30 (chat-assistant.service.ts:105). | M |

**1B — Orchestrator-side context injection** (port of legacy orchestrateContext
channels that tools can't replace):
| # | Item | Shape | Effort |
|---|---|---|---|
| 1B.1 | **Authoritative client roster** | port commit 007ebdb's fix: roster read in MeriContextResolver (client.findMany) + AUTHORITATIVE block in buildChatSystemPrompt + roster-wins prose. Hard-grep confirmed absent today — the roster fix currently only reaches the legacy fallback path. | M |
| 1B.2 | Client-steering/client-people layers | thread dto.clientId into resolver.resolve; request the layers (adapter already supports them, context-compiler.service.ts:46-58); render client soul/strategy block. NO path exists today (neither injected nor tool-reachable). | S |
| 1B.3 | Firm skills injection | resolve matched skill in the proxy (owns MeriFirmSkillsService + intent) and forward `systemAddendum` as a ChatInput field (memoryContext pattern) | M |
| 1B.4 | Client KB snapshot | resolver-side pre-fetch when clientId set (shares 1B.1's client fetch), or strengthen prompt to force get_client_context on client turns | M |
| 1B.5 | Citations pipeline | lift extractCitationsFromToolResult/formatCitationsForPrompt/validateCitationMarkers from meri-citations.helpers.ts into @capiro/shared; wire into tool-result serialization + a citations ChatStreamEvent + proxy translation | L |
| 1B.6 | Compliance-guardrail + capability prose alignment | extract COMPLIANCE_GUARDRAILS to shared; align capability block if byte-parity matters | S |

Research/intel/public-web proactive injection: **downgrade-accepted** — available
on-demand via delegated tools; the agentic loop self-fetches. Revisit only if
answer-quality evals show regression (decision D3 below).

## 4. Wave 2 — Turn-coverage parity (close the routing gate)

| # | Item | Shape | Effort |
|---|---|---|---|
| 2.1 | Page-write mode | extend ChatInput with pageWrite flag; orchestrator captures draft body from draft_policy_memo/create_meeting_brief artifact result (extractChatArtifacts already returns bodyText); new `page_write` ChatStreamEvent + proxy translation. apps/api keeps parsing the 'write on this page:' prefix (meri.service.ts:2729-2731). | M |
| 2.2 | Vision / image turns | widen ChatInput messages to carry image blocks (base64 media_type+data); proxy forwards currentTurnImages; RequestScopedLlmClient.completeWithTools already takes content:unknown so the LLM layer carries blocks unchanged. Caveat: OpenAI-provider handling. | L |
| 2.3 | Extended thinking | add thinking params + block passthrough in completeWithTools + loop; gated by the tier signal from 1A.4 | M |
| 2.4 | Token-level streaming | completeWithTools is non-streaming per round → MeriV2 types in chunky bursts (UX regression vs legacy token stream). Add SSE streaming to the LLM client + loop. Decide: pre-cutover (recommended — visible) or accept. | L |
| 2.5 | Impersonated turns | orchestrator tenant-override for admin support sessions (today a deliberate guard — forwarded bearer would scope tools to the admin's home tenant, meri.controller.ts:268-275). Either build the override or keep a minimal legacy path for impersonation only until last. | M |

Exit: routing gate conditions removed one at a time, each behind its own
verification (parity run + eval + bake). Gate deletion order:
pageWrite → images → (impersonation last or retained).

## 5. Wave 3 — MCP bridge (hardest single item)

Per-tenant MCP connector tools reach the legacy loop via bridgedSchemasFor
(meri-mcp.service.ts:383) + dynamic execution. The orchestrator's registry is a
**constructor singleton of static catalogs**; /api/clio/tool-schemas returns only
static native schemas (meri.controller.ts:306). Port requires:
1. A per-(tenant,user) schema fetch (extend /clio/tool-schemas or new /clio/mcp-tools).
2. Request-scoped registry augmentation in the orchestrator (dynamic DelegatedToolSpec
   registration per turn; ApiToolExecutorRepo already forwards ANY toolName verbatim
   to POST /clio/tools/:name — verify the api-side dispatch accepts bridged MCP names).
3. Security review: MCP injection evals exist (mcp-injection-fixtures) — extend to
   the orchestrator path; keep the allowlist + audit discipline.

Effort XL, risk high. **Cutover gating rule (recommended):** tenants with zero
configured MCP servers can cut over without this; MCP tenants keep the legacy
branch until Wave 3 lands. Check live tenant MCP usage to size the real blast radius.

## 6. Wave 4 — Prove & flip

1. Run the M5 live parity workflow per surface (in-editor non-mutating case first,
   then chat golden transcripts) — green required before each Wave-2 gate removal.
2. Shadow-auditor ledger review after each wave (false-positive tuning per the
   auditor's own rollout note).
3. Monitor: meriv2_chat AI-usage events, meri_audit_ledger, SSE error rates,
   pending_approval volume (post-M1).
4. Bake ≥1 week of full-traffic MeriV2 with zero legacy fallbacks (except any
   retained impersonation path).

## 7. Wave 5 — Retire

DELETE (verified safe): legacy in-process branch of streamMessage + its private
helpers; dead generateProactiveAlerts (meri.service.ts:3536 — zero callers);
routing-gate conditions; `meriv2.fullChat` per-tenant flag (semantics collapse —
keep MERIV2_ENABLED only if a kill-switch pointing at a deleted fallback still
means anything; recommend delete both and rely on normal rollback).
KEEP (verified standalone, permanently in apps/api): MeriToolsService + /clio/tools,
Deep Research, scheduled-task runner, alert emitters + /clio/alerts, attachments,
artifact endpoints, memory CRUD + recall (proxy), MCP CRUD/OAuth + bridge api-side,
firm-skill CRUD, the proxy adapter itself.
Optional later hygiene: extract artifacts/alerts/memory methods out of the
MeriService god-class (L, mechanical).

## 8. Parallel infra track (independent of chat waves)

- **M4a (land now, dormant):** intel-api into CDK — config.ts fields + compute-stack
  service/TG/listener-rule(priority 18 on the CDK ALB) + gated secrets, mirroring
  meriv2/workspace. Verified safe to land: image workflow is build-only; naive
  cdk deploy errors without touching live traffic (wedged stack).
- **M4b (supervised cutover, decision):** adopt the out-of-band capiro-dev-intel-api
  service (CFN import vs delete/recreate); retire BOTH CodeBuild projects pinned to
  `feat/intel-api-live-hearing` (live prod intel-api is currently BUILT FROM AN
  UNMERGED BRANCH — real drift risk); reconcile the wedged Capiro-dev-Compute stack.
- **M6/M5:** shipped in Wave 0.

## 9. Decisions — RESOLVED 2026-07-14 (Ninja)

| # | Decision | RESOLUTION |
|---|---|---|
| D1 | M1: flip create_task/update_task to WARN on the live GA surface? | **DECIDED: YES** |
| D2 | Intent taxonomy: accept MeriV2's 5 plan-modes or port legacy's 14-intent + output templates? | **DECIDED: accept plan-modes** (templates only if evals regress) |
| D3 | Research/intel/web proactive injection: accept on-demand-tool downgrade? | **DECIDED: YES**, with an eval checkpoint |
| D4 | Token-level streaming before cutover? | **DECIDED: YES** (Wave 2) |
| D5 | Impersonated chat: build tenant-override or retain minimal legacy path? | **DECIDED: build the override** (Wave 2) |
| D6 | MCP bridge / MCP-tenant gating | **DEFERRED — leave as-is.** Note the standing implication: the routing gate does not check MCP, so MCP tools are ALREADY absent from MeriV2-served chat turns today; retirement later makes that universal until the bridge is built. Wave 3 is parked, not cancelled. |
| D7 | Parity target / rollout scope | **DECIDED: everyone.** No pilot-tenant staging — MeriV2 fullChat is already GA default-ON fleet-wide; parity verification runs via workflow_dispatch against prod (non-mutating cases), gates apply fleet-wide. |
| D8 | Deep Research / schedules / alerts stay in apps/api permanently? | **DECIDED: YES** — standalone; MeriV2-side reimplementation is optional future work, not on this plan |

## 10. Sequencing & rough effort

```
Wave 0 (safety/ops)        ~7 items, all S          — 1 focused sprint, parallelizable
Wave 1 (affordances)       6×S/M proxy + 6×S-L orch — 2-3 weeks
Wave 2 (turn coverage)     2×M + 2×L + 1×M          — 2-4 weeks
Wave 3 (MCP bridge)        1×XL                     — 2-4 weeks, can overlap Wave 2
Wave 4 (prove/flip)        gates + bake             — 1-2 weeks elapsed
Wave 5 (retire)            deletes + flag cleanup   — days, after rollback window
Infra track (M4)           parallel                 — code now, cutover scheduled
```

Ordering rules: Wave 0 anytime; 1A before 1B (proxy wins are independent);
2.x each gated on a parity run; Wave 5 only after Wave 4 bake. Nothing in
Waves 1-3 requires a migration; Wave 0.5 is comment-only SQL.
