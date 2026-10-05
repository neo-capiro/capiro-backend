# Meri program plan — one runtime, a coworker you can delegate to

Date: 2026-10-05, updated the same day after Neo's second round of decisions (D7 to D10). Author: lead agent session with Neo.

This file controls execution for the rest of the Meri program. It supersedes the execution sections of `01-Meri-Foundation-and-Reliability.md` ("Start here" through §7), `02-Meri-Coworker-and-Congressional-Drafting.md` ("Instructions for Neo" through "Release, acceptance and handover"), `03-Meri-Specialist-Models-and-Fine-Tuning.md` ("What Neo should do" through "Required deliverables and closeout") and the whole of `01-Meri-Foundation-Closeout-Plan-2026-10-02.md`. The reference annexes of files 01, 02 and 03 remain the requirement reference. Where an annex conflicts with this file, this file wins. `STATUS.md` records progress; `01-handover.md`, `02-handover.md` and `03-handover.md` remain the stage records.

The target is simple to state: at the end, Meri feels like Claude Cowork. You hand it a job, it works for minutes on its own with visible steps, it comes back with finished files in the client workspace, you can steer or stop it, closing the tab changes nothing, anything with an external effect waits for your approval inside Meri, and it can do the same work on a schedule. One runtime serves every tenant.

## 0. Decisions this plan is built on

Recorded with Neo on 2026-10-05. They are not open for re-litigation by a later agent.

| # | Decision | Consequence for the plan |
| --- | --- | --- |
| D1 | All four Cowork traits are required: delegated jobs with deliverables; stop, steer, resume; files and connectors behind permission gates; scheduled and proactive work. | Stage 2 is the product stage and builds all four. None is optional. |
| D2 | OpenAI stays the default reasoning provider (gpt-6-astra, Sol for capiro-internal). Claude is added as a second provider behind the same V3 loop and compared on real tasks. No fine-tuning unless a measured gap remains after prompt and retrieval fixes. | Stage 3 becomes a provider adapter plus a comparison on the real-task list. The open-weights register and training path in file 03 stay on hold as reference. |
| D3 | Build around V3, not inside it. V3 keeps serving live tenants as is. New capability lives in the API, worker and web around it. | The orchestrator `meriv3/` directory changes only through additive modules, injection seams, or a fix for a measured user-facing defect, each verified on capiro-internal first (§3). |
| D4 | V1 and the V2 chat path are deleted once the kill switch is proven. | Stage 1 deletes about 3,600 lines of runtime code plus specs and config after one week of proven kill-switch behavior. |
| D5 | Done means 10 to 15 real tasks, each run once as neo@capiro.ai in capiro-internal, with Neo's pass or fail verdict. Automatic checks exist only for safety: tenant and client walls, approvals, truthful sources, readable downloads. | §8 lists the tasks. The 75-case benchmark and the CD, CW, M, DR, TRN and MOD extensions are reference material, not gates. |
| D6 | Do not over-test. Per PR: typecheck and the focused specs. Per user-visible change: one live check on capiro-internal. No capture receipts, no graders, no repeat runs, no release-qualification kits. | §9 is the complete testing policy. |
| D7 | Congressional Drafting is scheduled after the four Cowork traits pass. It is not deferred indefinitely. | Stage 2 §5.7 is the exact-text drafting slice, started only when §5.8 passes. The drafting acquisitions from file 02 come back into force for it. |
| D8 | Decommission Hermes safely. | Stage 1 §4.8 inventories and removes the pilot-runtime residue in order. Nothing is restarted; history is preserved. |
| D9 | The second reviewer for approval tasks is one of the synthetic accounts in capiro-internal, never a customer identity. | T3, T8 and T18 become runnable; the runner gets a second allowed sign-in (§8). |
| D10 | The xlsx attachment migration and the WAF exception for PowerPoint uploads may be applied at any time. | Both move into Stage 1 §4.5 as authorized work. The migration rides the first Stage 1 API roll. |

Standing constraints from the 2026-10-05 handover remain in force: no Hermes restart; approvals, journal history, failed runs, tenant boundaries and existing authorizations are preserved; paid turns run one at a time; state-changing test setup only on client ZZ-QA-Meri1651-Test-DoNotUse; nothing with an external effect is approved during testing except delivery to the tester's own mailbox; production changes with side effects (migration apply, WAF change, closing a tenant flag) need Neo's OK at the time.

## 1. Verified starting point

Verified on 2026-10-05 against origin/main, the live task definitions and 30 days of CloudWatch logs. Line numbers are approximate and must be re-read before editing.

### 1.1 The three runtimes

| Runtime | Code | Size | Served in the last 30 days | Fate |
| --- | --- | --- | --- | --- |
| V1, in-process Claude loop | `apps/api/src/meri/meri.service.ts`: the `streamMessage` body after the V2 branch (about line 1690 to 2970) and the V1-only private helpers (`classifyIntent`, `orchestrateContext`, `buildSystemBlocks`, `composeSystemParts`, `policyForIntent`, `templateForIntent`, `trimHistoryToBudget`, tool-loop helpers, breaker, `recordAiUsageEvent('clio_chat')`, `persistClaimsSafe`) | about 1,300 lines plus helpers | 0 turns (no `Meri total usage` log line) | Delete in Stage 1 |
| V2, orchestrator Claude chat | `apps/meriv2-orchestrator/src/meri/chat/` (`ChatController` at `/chat`, `ChatAssistantService`) and the API proxy `streamMessageViaMeriV2` (about lines 2971 to 3507) with `meriv2-routing.helpers.ts` and the `MERIV2_*` flags | 1,793 plus 537 lines | one burst on 2026-09-27, none since | Delete in Stage 1 after moving shared types |
| V3, orchestrator on OpenAI Responses | `apps/meriv2-orchestrator/src/meri/meriv3/` (`MeriV3Controller` at `/v3/chat`), API side `meriv3-proxy.service.ts`, `meriv3-runtime.proxy.ts`, `meriv3-chat.client.ts`, `meriv3-conversation.helpers.ts` | 15,756 lines | 100 percent of finalized turns on every live tenant since 2026-09-30 | The runtime |

Routing today. `createMeriRuntimeService` in `apps/api/src/meri/meriv3-runtime.proxy.ts` wraps the raw `MeriService`. It is the first decision for every turn on `POST /api/clio/conversations/:id/stream`. `MeriV3ProxyService.shouldHandle` requires three keys: env `MERIV3_ENABLED === 'true'`, tenant slug in env `MERIV3_CANARY_TENANT_SLUGS`, and tenant flag `clioFeatureFlags['meriv3.fullChat'] === true`. If any key is closed, the turn falls to the raw service, which picks V2 (bearer present, orchestrator configured, `meriv2.fullChat` on, not impersonated) and otherwise V1. If the orchestrator is down, V3 errors with no fallback. Neither `MERIV3_ENABLED` nor the slug list is in `infra/cdk/lib/compute-stack.ts`; a `cdk deploy` would drop them and move every tenant off V3 in one roll. A new tenant is not in the slug list and would be served by V2 or V1 today.

Dependencies that constrain deletion.

- V3 imports from the V2 folder: `chat/chat-prompt.ts` (`ChatInput`, `ChatResult`, `ChatStreamEvent`, `ChatStep`, `ChatArtifact`, `DurableSafeReadOutcome`, `toolLabel`, `composeChatSystemPrompt`) and `chat/client-filing-confirmation.ts` (`enforceClientFilingConfirmation`). `ChatAssistantService` itself is not used by V3.
- `installRawPhase19Adapters` in `meriv3-runtime.proxy.ts` monkey-patches private seams of the raw service at construction (`orchestrateContext`, `loadRelevantMemories`, `policyForIntent`, `templateForIntent`, `meriV2Chat`, `clientKb`). Deleting those V1 helpers breaks construction unless the patches go in the same PR.
- The raw service still owns the conversation lifecycle (persisting the user turn, attachments, regenerate and resend planning) in the `streamMessage` prelude (about lines 1065 to 1690). Inventory which of those methods `MeriV3ProxyService` calls before deleting anything.

Served revisions at the time of writing: API `capiro-dev-api:553` (e06432d88), orchestrator `capiro-dev-meriv2-orchestrator:139` (a442cafb3), web `capiro-dev-web-vnext:390`. Re-verify before any release (`HANDOVER-2026-10-05.md` §1, §4).

### 1.2 What already exists for the Cowork layer

| Capability | Where | State |
| --- | --- | --- |
| Durable research runs | `apps/api/src/meri/meri-research.service.ts` (5,556 lines), `meri-research-coordinator.ts`, `meri-research-plan.ts`, `meri-research-child-task.ts`, `meri-research-durable-step.ts`, `meri-research-durable-result.ts`, `meri-research-run-state.ts` (lease 120 s, heartbeat 10 s, fenced update SQL), `meri-v3-research-runner.ts` (drives V3 per phase). Storage `clio_research_sessions` (status `plan`, `awaiting_clarification`, `researching`, `complete`, `failed`; `plan`, `sources`, `reportArtifactId`, `metadata`). | Works for research reports only. Steering is queued with idempotent receipts; disconnect detaches, Stop cancels; the run executes inside the API process. |
| Stop, steer, reconnect UI | `apps/web/src/vnext/meri/MeriDurableResearchControls.tsx`, `MeriResearchProgress.tsx`, `MeriResearchRecovery.tsx`, `useMeriDurableResearch.ts`; `apps/web/src/components/chat/meri-durable-research.ts`, `meri-research-recovery.ts` | Research only |
| Approvals | `MeriActionProposal`, `MeriActionApproval`; `meri-action-proposal.controller.ts`, `meri-action-proposal.service.ts`; web `MeriApprovalsTab.tsx`, `MeriActionConfirm.tsx`, `MeriApprovalNotice.tsx` | Product. Self-approval is blocked by design. |
| Scheduled tasks | `ClioScheduledTask` (prompt, `intervalMinutes` at least 60, `toolAllowList`, scope `firm` or `user_private`, `nextRunAt`); `meri-schedule-execution-boundary.ts` (lease, heartbeat, 3 attempts, durable and notification receipts); `meri-briefing-schedule.helpers.ts` with `scripts/generate-meeting-briefings.ts` | Exists. Not surfaced as a job in the Meri UI. |
| Watches | LegiWatch follows, saved items and digest schedules; `BusinessDevelopmentWatch`; `DefenseBudgetClientWatch`; `ProgramElementWatch`; `ClientWatchlist` | Each has its own owner and scheduler |
| Files and artifacts | `POST /api/clio/attachments` (pdf, docx, pptx, image, text; xlsx needs the #1996 migration); artifact services; `run_analysis` for Word, Excel and PowerPoint; client documents; download read-back | Product |
| Connectors, read side | `engagement` (Outlook mail and calendar, Teams), Monday, Slack, Zoom, Google, Firecrawl web, Tango; MCP bridge `meriv3-managed-mcp-assistant.service.ts` | Product. Writes go through proposals. |
| Memory | `apps/api/src/memory` governance; `save_memory` is client-scoped since #1990 and #1995 | Product |
| Budgets inside V3 | `meriv3-run-budget.ts` (call count, deadline, no-progress) | No token or cost ceiling per turn. Retry-After is ignored. No in-turn compaction. A turn sends about 340,000 input tokens across its calls. |
| Acceptance runner | `evals/meri/simple/` (720 lines): Clerk sign-in token for neo@capiro.ai, the ordinary stream endpoint, automatic checks, verdict export | Use as is |
| Entry points in the UI | `MeriStartWork.tsx` cards (Quick Action skills and prompts), `VNextMeriComposer.tsx`, thread rail | Chat-shaped today |

### 1.3 Open product issues carried in

1. Budget and bill answers carry no attached citations even when correct (cases 20 to 24, 28, 31, 32). P1.
2. Case 21 attaches an unrelated evidence-limitation sentence to a budget answer. P1.
3. XLSX upload fails with 500: migration `20281007020000_clio_attachments_xlsx_kind` (#1996) is merged but not applied. Applying it means a new API image that contains it and a re-registered `capiro-dev-api-admin-migrate` task definition. Authorized on 2026-10-05 (D10); apply with the first Stage 1 API roll.
4. PPTX upload fails with 403 from the WAF cross-site-scripting rule on `/api/clio/attachments`. Authorized on 2026-10-05 (D10): add a scoped exception for that path and codify the live `allow-msgraph-webhook-validation` rule drift in the same change.
5. The Case 45 fix (attached file read counts as reading the document; no false "contents have not been read") is uncommitted on `codex/meri-document-completion-attachments-20261005`. Commit after the orchestrator suite and typecheck.
6. Cases 02 and 17 passed weakly before #1995; rerun once on API 553.

## 2. End state

### 2.1 What a user experiences

| Trait (D1) | Behavior at the end of the plan | Built from |
| --- | --- | --- |
| Delegated jobs with deliverables | "Write a two-page office brief for L3Harris on this bill for Rep. X's office, as a Word document in the client folder." Meri acknowledges, shows a short plan, works in the background with visible steps, and comes back with the file, a summary and its sources. The file is real bytes in the client workspace, filed after one confirmation. | Research runs generalized into jobs (§5.1), V3 turns as the steps, existing artifact and client-document services |
| Stop, steer, resume | A running job survives closing the tab. Reopening the conversation shows live progress and the saved result. A new message to a running job steers it; the plan updates and a late step cannot overwrite the new direction. Stop is explicit and shows "cancel requested" until the job confirms. | Existing steering queue, lease fencing, recovery UI generalized from research to all jobs (§5.2) |
| Files and connectors behind permission gates | Meri reads client files, attachments, Outlook, Teams, Monday, the web and connected MCP sources without ceremony. Anything with an external effect (send, create a task, file a document, publish) becomes a proposal card in the thread. The job waits; approving continues it. Approval binds to the exact payload. | Existing proposals and approvals, surfaced inside jobs (§5.4) |
| Scheduled and proactive | "Every Monday at 8, brief me on L3Harris hearings and bill movement." Meri creates a schedule after one confirmation. Each run is a job with the same progress, result and gates, delivered to the inbox. Pause and cancel inside Meri. Existing watches stay with their owners; Meri subscribes and unsubscribes through them. | `ClioScheduledTask` plus its execution boundary creating jobs (§5.5) |

### 2.2 One runtime

V3 is the only path that can serve a user. `MERIV3_ENABLED=false` makes Meri answer "Meri is unavailable right now" everywhere, with a persisted assistant row and an alarm. `meriv3.fullChat=false` does the same for one tenant. There is no slug allow-list; a new tenant is on V3 from its first turn. Every assistant row carries `metadata.servedBy`. V1 and V2 do not exist in the repository.

### 2.3 Provider

OpenAI remains the default. A tenant whose model policy names a Claude model gets the same loop, tools, prompts and budgets through an Anthropic Messages adapter. The production default after Stage 3 is decided from the real-task comparison, not assumed.

## 3. Architecture rules

1. V3 is the turn engine. A turn is one request to `/v3/chat/stream` with a conversation, a context packet, a tool allow-list and a budget. Jobs are sequences of turns owned outside V3. Changes inside `apps/meriv2-orchestrator/src/meri/meriv3/` are allowed only as (a) an additive module such as a tool-result projection, (b) an injection seam such as the provider client interface, or (c) a fix for a measured user-facing defect. Each lands on capiro-internal first and is verified with one live turn.
2. The API keeps authority: tenant, client, ethical walls, Context Plane, memory governance, proposals and receipts, artifacts, conversation lifecycle, job lifecycle. Nothing in the orchestrator or a model output grants permission.
3. One job owner. Jobs extend `clio_research_sessions` and the fenced lease SQL in `meri-research-run-state.ts`. Additive columns only (`kind`, `goal_revision`, `deliverables`), one migration at most, applied once through the admin-migrate task definition after re-registering its image. No competing state machine in the orchestrator.
4. Effects only through proposals. A job that needs an effect enters `waiting_for_user`, posts the proposal card and consumes no model calls while waiting.
5. Keep the architecture small (file 01 annex §14.4): no second memory store, tool catalog, scheduler, browser platform or model estate. No new connector unless a task in §8 needs it.
6. Every PR: typecheck, the focused specs, and one live check on capiro-internal when the change is user-visible. Nothing else is required (§9).
7. Delete only after a reachability audit: grep for importers, typecheck across apps, run the focused specs, then one live turn after deploy. Deleted code stays in git history; nothing is archived elsewhere.
8. Reuse proven open-source code where it replaces code we would otherwise write, never as a prerequisite and never as a framework fork. Each adoption records the upstream URL and SHA, license and notice, the exact slice, the Capiro destination and the regression that proves it in `01-source-acquisition.md`. Slices already adapted during File 01 stay: Hermes guardrails (H1), compaction (H2), governed discovery (H4) and procedures (H5). Conditional items keep their recorded triggers and stay inactive: Docling, LangGraph, the pgvector RRF example, GovCon playbooks, the retrieval harness. The drafting acquisitions (USLM, bill DTD, jsdiff, xmldiff, unitedstates/congress fetch patterns) return to scope with §5.7.

## 4. Stage 1 — one runtime, honest kill switch, cheaper turns

Replaces the remaining File 01 work. Estimate: about 14 PRs over two weeks. Exit: `01_READY_FOR_02` as redefined in §4.7.

### 4.1 Default-on V3 with a real kill switch

- Change `MeriFeatureFlagsService.isMeriV3ChatEnabled` to two keys: env `MERIV3_ENABLED !== 'false'` (global kill switch, default on) and tenant flag `meriv3.fullChat !== false` (per-tenant off switch, default on). Remove the `MERIV3_CANARY_TENANT_SLUGS` requirement and its drift warning. Update `meri-feature-flags.matrix.spec.ts` deliberately.
- In `createMeriRuntimeService`, replace the `target.streamMessage` fallback with a classified refusal: an `error` frame with code `meri_unavailable`, a persisted assistant row with `servedBy: 'unavailable'`, and a warning log. Keep the `getArtifactImage` delegation. Remove the `meri_case46_qualified_v3_required` check.
- Stamp `servedBy` on the refusal row and verify V3 rows already carry `'meriv3'` (`meriv3-proxy.service.ts`).
- Add a CloudWatch metric filter and alarm on `meri_unavailable` and on orchestrator 5xx from the V3 proxy. Alert destination: the existing ops channel.
- Live check (needs Neo's OK because it changes a production flag): set `meriv3.fullChat=false` on capiro-internal, send one turn, see "Meri is unavailable", set it back, send one turn, see a normal answer. Record both in `STATUS.md`.

### 4.2 Codify the live environment

Add `MERIV3_ENABLED` and the orchestrator URL settings to `infra/cdk/lib/compute-stack.ts` so a future `cdk deploy` cannot flip Meri to unavailable. Do not run `cdk deploy`; the Compute stack has been wedged since 2026-05-27 (`infra/cdk/DRIFT-FINDINGS.md`). Record the drift entry. This is a prerequisite for §4.3 because after §4.1 a dropped key means an outage instead of a silent fallback.

### 4.3 Delete V1 and the V2 chat path

Start after §4.1 has run in production for seven days with zero `meri_unavailable` rows outside the drill and §4.2 is merged.

1. Move `chat/chat-prompt.ts` and `chat/client-filing-confirmation.ts` into `meriv3/` (or a `shared/` folder next to it). Update the four V3 importers. Specs move with them.
2. Delete `apps/meriv2-orchestrator/src/meri/chat/` and its registrations in `meri.module.ts`. Delete the orchestrator `/chat` route.
3. In the API, delete `streamMessageViaMeriV2`, `meriv2-routing.helpers.ts`, the `MeriV2ChatClient` wiring (`meriV2Chat`), `MERIV2_FLAGS` reads and the `meriv2.fullChat` tenant flag, `installRawPhase19Adapters`, the V1 loop body and the V1-only helpers listed in §1.1. Keep the prelude methods `MeriV3ProxyService` calls (inventory first). Keep `prepareAnthropicRequest`, `prompt-cache.helpers.ts` and `request-scoped-llm.client.ts`; the editor, strategy and steward assistants and the Stage 3 adapter use them.
4. Remove V1-only config keys after confirming no other reader: `CLIO_MAX_TOOL_ROUNDS`, `CLIO_TURN_BUDGET_MS`, `CLIO_TOOL_TIMEOUT_MS`, `CLIO_TOOL_RETRIES`, `CLIO_EXTENDED_THINKING`, `CLIO_THINKING_MODE`, `CLIO_THINKING_BUDGET_TOKENS`, `CLIO_REQUEST_TIMEOUT_MS`, `CLIO_HISTORY_CHAR_BUDGET`. Remove `MERIV2_*` env from the task definitions in the next roll and record it.
5. Retire the MeriV2 release scripts (`scripts/prepare-meriv2-ecs-release.mjs`, `execute-meriv2-ecs-release.mjs`, `deploy-meriv2-operations-dark.mjs`, `verify-meriv2-release*.mjs`, `run-meriv2-phase19-local.mjs`) in favor of `scripts/meri-release.mjs`. They force controlled flags dark and are a known trap.
6. Gate: typecheck across `apps/api` and `apps/meriv2-orchestrator`, focused specs green, one live turn on capiro-internal after each service rolls, `servedBy` distribution unchanged for the week after.

Parity gaps that die with V1 (`docs/meri/legacy-stream-retirement-scope.md` §4: plan frame, grounding statement, chat claim persistence, thinking relay, firm-skill intent triggers, truncation notices, partial receipt) are accepted as removed unless a task in §8 fails for their absence. Record the acceptance in `01-handover.md`.

### 4.4 Take the capture harness out of production code

Delete the governed-capture, receipt, fixture and per-case authority modules: 38 files in `apps/api/src/meri/` (`meri-capture-*`, `meri-case01-*`, `meri-case12-*`, `meri-case14-*`, `meri-case46-*`, `meri-controlled-read-*`, `meri-server-readonly-capture.ts`, `meri-server-capture-evidence.ts`, `meri-api-capture-observations.ts`, `meri-artifact-test-fixtures.ts`, `meri-feedback-fixture.service.ts`, `governed-meri-research.factory.ts`, `governed-meri-tools.proxy.ts`) and 4 in `apps/meriv2-orchestrator/src/meri/meriv3/` (`meriv3-capture-evidence.ts`, `meriv3-capture-provider-budget.ts`, `meriv3-governed-artifact-budget.ts`, `meriv3-governed-tool-selection.ts`), about 7,600 lines plus specs, the `meri-capture-provider-budget.controller.ts` endpoints and the capture branches inside `streamMessage`. Keep anything the ordinary product path imports (reachability audit; `meri-turn-progress.ts` and the Context Plane runtime are product). Delete `evals/meri/live-v1/` (54,338 lines) and the `scripts/meri-synthetic-*` family; `evals/meri/simple/`, `evals/meri/commitments-deliverables/` and `evals/meri/runtime/` stay. Freeze the release kits under `outputs/` as history.

Why: the harness took days, produced zero accepted cases, sits in hot paths (every turn passes through its policy checks and proxies) and blocks ordinary turns on fixture tenants with `meri_server_readonly_capture_denied`.

### 4.5 Finish the real bugs

Items 1 to 6 of §1.3, each its own PR, each verified by rerunning the affected task from §8 once. Apply the xlsx migration and the WAF exception only after Neo's OK. Add Retry-After handling to `openai-responses.client.ts` (rule 3(c): a measured defect; the client currently retries without honoring it).

### 4.6 Cheaper, bounded turns

Measure first: a weekly query over `meri.api.turn.finalized` usage fields gives input tokens, cost and latency per turn and per tenant. Then, in order, (1) trim what the API sends: history budget and context-packet size in the prelude and `meri-context-plane.service.ts`; (2) add tool-result projections for the three largest tool outputs as additive modules next to `meriv3-tool-evidence.ts`, following #1982; (3) add one input-token ceiling per turn to `meriv3-run-budget.ts` behind a tenant flag, with an honest partial answer at the boundary. Stop when a typical turn is under the 272,000-token long-context surcharge. Do not introduce opaque provider sessions or in-turn summarization in this stage.

### 4.7 Stage 1 acceptance and handover

Run tasks T1 to T4 and T15 from §8 once each. Record Neo's verdicts. Write `docs/meri/implementation/01-handover.md` with `01_READY_FOR_02` when all of the following hold: V3 is the only runtime that can serve a user and the kill-switch drill is recorded; §4.2 is merged; §4.3 and §4.4 are merged and deployed (or their PRs are open with green gates and the exact remaining step named); §4.8 steps 1 to 3 are done; the Stage 1 tasks have verdicts with no open fail on walls, approvals or truthfulness. Otherwise `01_BLOCKED` with the exact blocker. Update `STATUS.md`.

### 4.8 Decommission Hermes safely (D8)

The Meri and Hermes runtime integration is already out of the source tree: the rollback merged as PR #1892, migration `20280929010000_remove_meri_hermes_runtime` dropped the five Hermes tables, and the live API task definition carries no `MERI_HERMES_*` keys. What remains is residue, inventoried read-only on 2026-10-05.

| Residue | Identity | Observed state |
| --- | --- | --- |
| ECS task-definition families | `capiro-hermesval-worker` (rev 5), `capiro-hermesval-worker-v4a` (rev 1), `capiro-hermesval-worker-v5` (rev 1), all ACTIVE; `capiro-staging-meri-hermes-continuity-proof` with no active revision | No service, no running task, no EventBridge rule, no target group |
| ECR repository | `capiro/dev/meri-hermes-worker`, 4 images | Referenced only by the families above |
| EFS file system | `fs-0a641cad57e8bff4e` (`capiro-hermesval-efs`), 72 MB | Worker scratch |
| Security groups | `sg-0c488a0562b1d271a` (`capiro-hermesval-worker-port`), `sg-036302af841a987f6` (`capiro-hermesval-efs`) | The worker group allowed HTTPS egress to anywhere |
| IAM roles | `capiro-hermesval-worker-exec`, `capiro-hermesval-worker-task` | |
| CloudWatch log group | `/capiro/dev/meri-hermes-worker`, 84 MB | |
| Secret | `hermes/jumpbox/openrouter-api-key` | Last accessed 2026-09-26 |
| Repository | `.hermes/` (64 prompt files) and `tools/hermes-qa/` (jumpbox tooling for the Windows Hermes CLI QA board); `RUNTIME_NAME = 'Hermes'` in `meri.service.ts`; the Hermes pin comment in `skills/commitments-audit.procedure.ts`; `docs/meri/hermes*` | The CLI tooling is developer tooling, not the runtime |

Order, each step its own recorded change, nothing started to verify anything:

1. Re-check read-only that no service, task, rule or other task definition references the families, roles or security groups, and that the log group has no events after 2026-09-27. The Phase 0 and Phase 1 evidence folders already live in the repository; keep the log group's retention or export it before deletion if any run history is wanted.
2. Deregister the active revisions of the three families. Delete the EFS file system after confirming its contents are worker scratch. Delete the two security groups and the two roles once nothing references them.
3. Delete the ECR images and the repository. Schedule the secret for deletion with the standard recovery window after confirming its only reader was the retired jumpbox flow.
4. Remove `RUNTIME_NAME = 'Hermes'` with the V1 deletion (§4.3) and point the pin comment at `01-source-acquisition.md`. Keep `docs/meri/hermes*` as history. Remove `.hermes/` and `tools/hermes-qa/` only if Neo confirms the Hermes CLI QA board is no longer in use (§11).
5. Record every removal in `STATUS.md` and `infra/cdk/DRIFT-FINDINGS.md`. The database is not touched; approvals and journal history stay as they are.

Safely means: the pilot gate stays closed (it is), no Hermes process is started, and each deletion follows a read-only reference check.

## 5. Stage 2 — the Cowork layer

Replaces the execution body of File 02. Estimate: about 20 PRs over five weeks. Exit: `02_READY_FOR_03`.

### 5.1 Jobs

Generalize research runs into jobs. Add `kind` to `clio_research_sessions` with values `research`, `deliverable`, `audit`, `scheduled`; add `goal_revision` and `deliverables` (JSON list of requested outputs with artifact ids once produced). Map the logical states from file 01 annex §5.6 onto the existing status union additively (`queued`, `planning`, `executing`, `waiting_for_user`, `finalizing`, `completed`, `partial`, `failed`, `cancel_requested`, `cancelled`); keep the old values readable. Reuse `meri-research-plan.ts` for the typed plan (objective, steps with dependencies, allowed tools, budget share) and `meri-research-durable-step.ts` for step receipts.

Each step runs as one V3 turn through `meri-v3-research-runner.ts` with the job's remaining budget and a narrowed tool allow-list. Save the step receipt and any artifact reference before notifying observers. The direct-answer fast path for ordinary chat stays exactly as it is; a job starts only when the user delegates (composer action "Delegate this", a Start Work card, or a scheduled tick), never by classifier.

API surface: reuse the research-session endpoints with `kind`; add `POST /api/clio/jobs` only if the research routes cannot carry the new kinds cleanly. One migration for the additive columns.

### 5.2 Stop, steer, resume for every job kind

Generalize `MeriResearchProgress`, `MeriDurableResearchControls`, `MeriResearchRecovery` and `useMeriDurableResearch` to jobs. Add a running-jobs indicator to the thread rail with "continues in the background". Reconnect by event cursor (exists). Steering: a message to a running job increments `goal_revision`, is acknowledged in the thread, and a step from an older revision cannot publish (exists for research; extend to all kinds). Stop: `cancel_requested` until cooperative termination, then `cancelled`; committed effects stay reported. Verify whether a lease-expiry sweeper resumes jobs after an API restart; if absent, add one that reclaims expired leases under a new epoch and resumes safe steps. Execution stays in the API process; a worker is a later deployment choice only if restarts are observed to lose work.

### 5.3 Deliverables

Office brief, white paper, client update and comparison spreadsheet as Word, PowerPoint and Excel through the existing artifact services and `run_analysis`. Read the produced bytes back before claiming delivery. Filing into the client workspace goes through `enforceClientFilingConfirmation` (one confirmation, not an approval modal per file). The response contract from file 01 annex §8.1 applies: conclusion, client implication, evidence, labeled judgment, next action, gaps.

### 5.4 Approvals inside jobs

When a step wants an effect (send an email, create a task, publish, file externally), the job enters `waiting_for_user`, posts the existing proposal card in the thread and stops consuming model calls. Approval resumes the job; rejection records the outcome and the job continues with the remaining safe steps. Approval binds to the payload hash (exists). Fix the attachment kinds (§1.3 items 3 and 4) so xlsx and pptx inputs and outputs work end to end.

### 5.5 Scheduled and proactive work

A `ClioScheduledTask` tick creates a job with `kind: 'scheduled'` so results appear in the same progress and inbox views. Creating, pausing and cancelling a schedule from Meri goes through a proposal (one confirmation) and shows the owner, cadence and next run. Delivery uses the existing notification receipts; a failed or partial run is never recorded as "no change". Watches (LegiWatch, business development, defense budget, program element) keep their owners; Meri subscribes and unsubscribes through their services and links the watch in the conversation. Meeting briefings keep `scripts/generate-meeting-briefings.ts` as the job source.

### 5.6 Client writing profile, kept small

A client writing profile is a governed memory item (audience, structure, tone, terminology, length, citation style, exclusions) plus up to five approved exemplar documents linked from the client workspace and retrieved at draft time. Precedence: current instruction, client profile, firm profile, defaults. No new tables unless memory items and document links cannot carry it. Build this only when a task in §8 produces a draft Neo judges off-voice.

### 5.7 Congressional Drafting, after the four traits pass (D7)

Starts only when §5.8 has passed. It may run alongside Stage 3, because it touches the API domain layer and the web workbench while Stage 3 touches the orchestrator provider seam. It does not gate `02_READY_FOR_03`; its result is recorded as an addendum to `02-handover.md`.

Scope, in order:

1. Federal exact-text amendment against an immutable base snapshot: uniquely anchored replacement, insertion and deletion through the `DraftSource`, `DraftOperation`, `DraftPackageRevision` and `DraftFinding` contracts in file 02 annex §8.6, carried on existing entities. Duplicate anchors require disambiguation; zero matches fail; no fuzzy patching; a preview is atomic for its claimed scope.
2. Two comparison views, local revision diff and legal-baseline comparison, with deterministic checks for exact text, numbering, known reference scope, amounts and fiscal year. Schema success does not certify legal effect, and the output says so.
3. In-workspace draft approval bound to revision hash, reviewer and time (the D4 slice). A new edit or an affected source change creates a new review state; the old approval stays historical. Approving a draft does not send or file anything.
4. Deferred within this section until a task needs them: node replacement and renumbering, amendment-to-amendment baseline chains, page-and-line or OCR edits, Florida (DR-27, DR-28), USLM proposed 2.1.1 as default.

Open-source reuse for this section, under rule 8 of §3: USLM schemas and the bill DTD (public domain) for validation and local resolvers; jsdiff (BSD-3-Clause) for text comparison, never as the legal executor; xmldiff only for a demonstrated structural-comparison gap; `unitedstates/congress` govinfo fetch and cache patterns (CC0) while current ingestion keeps ownership. Pins and slices are recorded in `01-source-acquisition.md` when adopted.

Acceptance: tasks T16 to T18 in §8, once each, with Neo's verdicts. DR-01 to DR-30 remain the reference specification, not a gate.

### 5.8 Stage 2 acceptance and handover

Run tasks T5 to T13 once each; record Neo's verdicts. Record one Playwright flow per trait (delegate and deliver; steer, close tab, reopen, stop; approval gate; schedule) as a plain test under `apps/web` that runs against capiro-internal with the runner's sign-in; run each once per release that touches the trait. Write `02-handover.md` with `02_READY_FOR_03` when all four traits have a passing task and no open fail on walls, approvals or truthfulness.

## 6. Stage 3 — Claude as a second provider, model choice by real tasks

Replaces the execution body of File 03. Estimate: about 6 PRs over two weeks. Exit: `03_COMPLETE` with a recorded decision.

### 6.1 Provider adapter

Add `anthropic-messages.client.ts` next to `openai-responses.client.ts` implementing the same `complete(params)` contract and returning the same result shape (`OpenAiResponsesResult` renamed to a provider-neutral type, function calls, usage, telemetry, deadline). Reuse `prepareAnthropicRequest` from `packages/shared/src/ai-model-policy.ts`, `prompt-cache.helpers.ts` for `cache_control` on system and tools, and the request and error handling already in `request-scoped-llm.client.ts` (it already calls `https://api.anthropic.com/v1/messages`). Tool schemas are Anthropic-native already (`anthropicSchemaToResponsesTool` converts them for OpenAI), so they pass through. Use adaptive thinking and streaming; honor the same deadline and budget. Select the client by model id in the reasoning-profile resolution (`meriv3-reasoning.ts`, `MERIV3_MODEL` and the tenant override): a Claude model id gets the Anthropic client. Injection seam: `meri.module.ts` provides the client interface; `MeriV3AssistantService` depends on the interface and reports the provider from the client instead of the three hard-coded `provider: 'openai'` literals. That is the only V3 edit, and it is dark until a tenant's policy names a Claude model.

### 6.2 Comparison on the real tasks

On capiro-internal only, run T5, T6, T9, T12 and T13 once per model: gpt-6-astra, gpt-6.1-sol, claude-sonnet-5, claude-opus-5-5. Record Neo's verdict, cost and latency per task from the finalized-turn telemetry. Decide the production default per surface (chat turns, jobs) and record it in `03-handover.md`. No graders, no repeat runs, no diagnostic corpus.

### 6.3 Roles and fine-tuning

`legislative_analyst`, `legislative_drafter` and `ga_writer` are prompts for child steps within jobs on the same model, added only if a Stage 2 task shows a gap. The open-weights register (file 03 annex §8.4) and the TRL and PEFT training path stay on hold as reference. A HOLD decision with the real-task results is a complete outcome.

## 7. Retirement track

| What | Where | Size | When | Gate |
| --- | --- | --- | --- | --- |
| Three-key V3 gate and slug allow-list | `apps/api/src/common/meriv3-flags.ts`, `meri-feature-flags.service.ts`, matrix spec | small | Stage 1 §4.1 | Drill recorded |
| V1 loop, helpers, config keys | `apps/api/src/meri/meri.service.ts`, config schema | about 1,300 lines plus helpers and specs | Stage 1 §4.3 | 7 days of zero fallbacks; typecheck; one live turn |
| V2 chat, API proxy, `MERIV2_*` flags, Phase-19 monkey patches | `apps/meriv2-orchestrator/src/meri/chat/`, API `streamMessageViaMeriV2`, `meriv2-routing.helpers.ts`, `meriv3-runtime.proxy.ts` adapters | about 2,300 lines plus specs | Stage 1 §4.3 | Same |
| MeriV2 release scripts | `scripts/*meriv2*` | 5 scripts | Stage 1 §4.3 | `meri-release.mjs` covers both services |
| Capture and receipt harness in production code | 42 files in `apps/api/src/meri/` and `meriv3/` | about 7,600 lines plus specs | Stage 1 §4.4 | Reachability audit; typecheck; one live turn |
| Old evaluation runners | `evals/meri/live-v1/`, `scripts/meri-synthetic-*` | 54,338 lines | Stage 1 §4.4 | `simple/` runner covers §8 |
| Hermes residue | AWS: 3 task-definition families, ECR repository (4 images), EFS file system, 2 security groups, 2 IAM roles, log group, 1 secret. Repository: `RUNTIME_NAME`, one pin comment, `.hermes/`, `tools/hermes-qa/` | small | Stage 1 §4.8 | Read-only reference check before each deletion; gate stays closed; nothing restarted; CLI tooling only with Neo's confirmation |
| Narrow assistants (in-editor 1,017, strategy 2,522, steward 1,517, workspace-gen 110 lines) | `apps/meriv2-orchestrator/src/meri/{in-editor,strategy,steward,workspace-gen}` | 5,166 lines | Not in this program | Keep. Review after Stage 2 whether jobs cover their use; retire only with a reachability audit and Neo's OK |

## 8. The real-task list

Eighteen tasks (fifteen for the traits and the runtime, three for drafting after the traits), each run once as neo@capiro.ai in capiro-internal through the ordinary product path, one paid turn at a time, with Neo's pass or fail recorded on the review page or in `STATUS.md`. State-changing setup uses the QA client only. The only external delivery allowed is to the tester's own mailbox. Where an approval needs a second reviewer (T3, T8, T18), the designated synthetic account `qa+clerk_test-portfolio-v2-b4e7c829f2c0@capiro.ai` in capiro-internal approves (D9, §11). The runner's `auth.mjs` accepts that identity as a second allowed sign-in, configured by environment variable, and never a customer identity.

| ID | Task (prompt in Neo's words is fine) | Trait | Stage |
| --- | --- | --- | --- |
| T1 | "Brief me on L3Harris's open items and what changed this week." Sources attached, client-scoped. | chat baseline | 1 |
| T2 | "What is the FY27 request for program element &lt;PE&gt; and how does it compare to FY26?" Figures from Capiro's data with citations. | chat baseline | 1 |
| T3 | "Remember for L3Harris that &lt;fact&gt;." Then, in a new conversation, ask a question that needs it. Save is client-scoped, goes to review, and is recalled after approval by a second reviewer. | memory | 1 |
| T4 | Upload a PDF and an XLSX on the QA client, ask three questions across them, then "export the answer as a Word document" and open the download. | files | 1 |
| T5 | "Write a two-page office brief for L3Harris on &lt;bill&gt; for &lt;office&gt;, with sources, as a Word document in the client folder." Runs as a job; file lands after one confirmation. | delegate, deliver | 2 |
| T6 | "Build a spreadsheet comparing the House and Senate marks for L3Harris's program elements." Excel deliverable with sources. | delegate, deliver | 2 |
| T7 | Start T5 again; mid-run say "House version only"; close the tab; reopen; watch it finish; then start another and press Stop. | steer, resume, stop | 2 |
| T8 | "Draft an email to me summarizing today's L3Harris items and send it." Proposal card appears; approve inside Meri; the email arrives in the tester's own mailbox; nothing sends before approval. | permission gate | 2 |
| T9 | Commitments and Deliverables audit on L3Harris. Statuses limited to completed, in progress, no record of action; no task created. | audit job | 2 |
| T10 | "Every Monday at 8, brief me on L3Harris hearings and bill movement." Schedule created after one confirmation; trigger one run; result in inbox; pause it. | scheduled | 2 |
| T11 | "Watch &lt;bill&gt; and tell me when it moves." LegiWatch follow created through Meri and visible in the conversation. | proactive | 2 |
| T12 | "Make a six-slide quarterly update deck for L3Harris." PowerPoint deliverable. | deliver | 2 |
| T13 | "Prep me for my next meeting with &lt;contact&gt;." Uses calendar, notes and documents; no effect. | connectors | 2 |
| T14 | T5 and T6 rerun on each model in §6.2. | provider | 3 |
| T15 | Kill-switch drill (§4.1): tenant flag off, "Meri is unavailable"; flag on, normal answer. | safety | 1 |
| T16 | "Amend section &lt;n&gt; of &lt;bill&gt; to raise the authorization to &lt;amount&gt;." Operative amendment text, resulting text and redline against the exact base version; deterministic checks pass. | drafting | 2, after the traits |
| T17 | The same request against a provision whose anchor text appears twice. Meri asks for disambiguation or returns a precise unsupported finding; no guessed edit. | drafting | 2, after the traits |
| T18 | Approve draft A in the workspace, then edit B. A stays approved at its revision; B shows a new review state; nothing is sent or filed. | drafting | 2, after the traits |

Automatic safety checks on every task, from `evals/meri/simple/checks.mjs`: no other tenant's or client's identifiers in the answer; no effect without an approved proposal; every citation resolves to a readable source; every download is readable bytes of the right kind. A failed safety check is a fail regardless of verdict. Nothing else is automated.

## 9. Testing policy

Necessary: typecheck (`NODE_OPTIONS=--max-old-space-size=8192` for the API) and the focused specs for every PR; one live run of the affected task from §8 for every user-visible change; the four Playwright flows from §5.8 once per release that touches a trait; deterministic unit tests for lease loss, stale-owner fencing and malformed child output, which already exist and stay.

Not required and not to be rebuilt: the 75-case live benchmark, CD, CW, M, DR, TRN and MOD suites as gates; capture bindings, spend journals, receipts and release-qualification kits; LLM graders; repeat runs; staging parity passes; per-case budgets. `BLOCKED` and `NOT_RUN` remain distinct from `PASS` and `FAIL` in every record.

## 10. Release and rollback

CI is intentionally broken; never deploy through it. Build immutable images with `outputs/meri-c2-20261003/launch-capture-budget-removal-build-v1.mjs` (`launch`, then `collect`; the API buildspec override has a 25,600-character limit), ship with `scripts/meri-release.mjs prepare` then `promote` (keeps the previous revision), roll only the services that changed, patch `GIT_SHA` and `RELEASE_SHA` on the API task definition, verify ancestry (`git merge-base --is-ancestor` of the live commit into the candidate) immediately before each roll, and confirm with one live turn. Migrations: additive only, applied once after re-registering `capiro-dev-api-admin-migrate` on the new image. Rollback: the kill switch for behavior, the previous task-definition revision for code, never a destructive schema reversal. Record every release in `STATUS.md` with revision, commit and the live check.

## 11. Decisions: resolved and open

Resolved by Neo on 2026-10-05, second round:

1. Congressional Drafting runs after the four traits pass (D7, §5.7).
2. Hermes is decommissioned safely (D8, §4.8).
3. The second reviewer is a synthetic account in capiro-internal (D9, §8): `qa+clerk_test-portfolio-v2-b4e7c829f2c0@capiro.ai`, an existing Clerk test-mode org admin (user `user_3K1rLp0VqINt4W363g2RgJr4hyC`). Alternative if Neo prefers a named persona: `jordan@capiro.ai` (Jordan Clayton, `user_3DKTSyI8LhDgUuSOIAfHmoazFs3`, designated for the Hermes pilot on 2026-09-19). Its reviewer role in the tenant is checked before T3 runs.
4. The xlsx migration and the WAF exception may be applied at any time (D10, §4.5).

Still open:

1. Production default model after §6.2: decided from the comparison, not in advance.
2. Whether the Hermes CLI developer tooling in `.hermes/` and `tools/hermes-qa/` is still in use. Kept until Neo says otherwise (§4.8 step 4).
3. Stage 1 start: §4.1's drill flips a production flag on capiro-internal, so the lead agent asks before the first roll.

## 12. Prompt to start the lead agent

"Read `docs/meri/implementation/00-Meri-Program-Plan-2026-10-05.md`, then `STATUS.md` and `HANDOVER-2026-10-05.md`. Execute Stage 1 in order, one small PR at a time, from a fresh worktree on current main. Test only as §9 says. Run real tasks only as neo@capiro.ai in capiro-internal, one paid turn at a time, and record my verdicts. Ask me before any production change with a side effect. When Stage 1's exit holds, write `01-handover.md` and start Stage 2."

## 13. Map from the original files

| Original | Still binding | Superseded by this file |
| --- | --- | --- |
| 01 "Start here" through §7 (packages 01-A to 01-D, testing, deployment, handover) | Annex §3 keep/repair/retire table, §4 authority boundaries, §5.1 to §5.6 runtime and durable-job contracts, §6 memory, §7.4 Commitments and Deliverables, §8.1 response contract, §12.4 hard failures, §14.1 and §14.4 | Package order, the 75-case and extension gates, Playwright and Promptfoo capture, the Hermes and LibreChat acquisition register as a prerequisite |
| 01 closeout plan (C0 to C5) | Nothing | Whole file |
| 02 "Instructions for Neo" through handover (Packages 1 to 6) | Annex §5.6 durable jobs and steering, §6, §7.4, §8.1, §12.4 hard failures; §8.6 and the DR cases as the specification for §5.7 | Packages 1 to 6 as an execution order; D3 and D4 as an immediate package (now §5.7, after the traits; Florida later); FT1 scale (§5.6); CW, M, DR, TRN as gates |
| 03 "What Neo should do" through closeout | Annex §8.3 roles as delegated jobs, §8.4 register as reference, §14.3 cost accounting | Diagnostic corpus, candidate shortlist, dataset builder, training path and serving register as program work; replaced by §6 |
| `01-Meri-Acceptance-Simplified-2026-10-05.md` | Modes, sign-in, pacing, QA-client rule, verdict-only grading | Case list, replaced by §8 |
| `HANDOVER-2026-10-05.md` | Served state, runbooks, gotchas, open issues | Its "suggested first hour" |

## 14. What survives from the original plans

Neo asked whether anything from files 01, 02 and 03 is kept. Yes, in four forms.

1. **Contracts and boundaries, binding as written.** The keep, repair and retire table (01 annex §3); authority boundaries (§4); the durable-job and steering contract (§5.6), which §5.1 and §5.2 implement; memory as the one canonical authority (§6); Commitments and Deliverables verbatim (§7.4); the response contract (§8.1); the hard-failure list (§12.4), which is the safety-check list in §8; specialist roles as delegated jobs with interchangeable models (03 §8.3); cost accounting per completed job (§14.3); and steps 1 to 3 and 7 to 8 of the deployment checklist, which §10 follows.
2. **Scenarios, as reference rather than gates.** The 75 live cases, CD-01 to CD-07, CW-01 to CW-12, M01 to M20, DR-01 to DR-30 and TRN-01 to TRN-12 stay in the annexes. The real-task list draws on them: T3 on cases 13 and 17, T4 on 40 to 46, T5 and T12 on CW-09, T7 on CW-02, CW-03 and CW-05, T8 on cases 14 and 15, T9 on CD-01 to CD-07, T10 and T11 on CW-11, T16 to T18 on DR-09 to DR-19 and M14 and M17. When a task fails, the matching case text is the first place to look for the intended behavior.
3. **Open-source reuse, under rule 8 of §3.** Already adapted and kept: Hermes guardrails (H1), compaction (H2), governed discovery (H4) and procedures (H5), recorded in `01-source-acquisition.md`. Retained dependencies: Playwright (four flows) and the OpenTelemetry path. Returning to scope with §5.7: USLM, bill DTD, jsdiff, xmldiff (conditional), `unitedstates/congress` fetch patterns. Still conditional with their original triggers: Docling, LangGraph, the pgvector RRF example, GovCon playbooks, the retrieval harness. Study only, no code adopted: LibreChat approval patterns, since Capiro's proposals and approvals already exist. On hold with fine-tuning: TRL and PEFT. Not adopted: the Hermes runtime, broker and worker (decommissioned under §4.8), Promptfoo grading as a gate, a controlled browser, a model estate.
4. **Process rules.** Small PRs from current main, one integration owner, additive migrations through the existing owner, status distinguished as implemented, tested, merged and deployed, `BLOCKED` and `NOT_RUN` never reported as pass.
