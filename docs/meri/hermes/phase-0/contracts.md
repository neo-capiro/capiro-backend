# Runtime, identity, event and UI contracts — Meri ⇄ Hermes (Phase 0)

Prepared September 19, 2026 against `feat/meri-hermes-phase-0` (base `19a1834ac`) and Hermes `v2026.9.14` (0.21.3). Types live in `apps/api/src/meri/hermes/hermes-runtime.contracts.ts`; behaviour in `meri-hermes-runtime.adapter.ts`, `meri-hermes-broker.service.ts`, `meri-hermes.controller.ts`. Status words: **verified** = exercised by the harness or unit tests in this branch; **proposed** = designed here, to be built in Phase 1+.

## 1. Where the runtime sits

```
browser ──SSE──▶ POST /api/clio/conversations/:id/stream
                    │ withMeriTurnProgress → governedRuntime.runChatTurn (Context Plane packet)
                    ▼
        createMeriRuntimeService proxy  ──▶ hermes.shouldHandle(ctx)?  ──yes──▶ MeriHermesRuntimeAdapter.streamMessage
                    │ no                                                       │
                    ▼                                                          ▼
        meriv3.shouldHandle(ctx)? → MeriV3ProxyService | legacy MeriService   Hermes worker /v1/runs (+events, stop, approval, steer)
                                                                               ▲
                                              worker plugins ──scope token──▶  /api/internal/hermes/broker/* (MeriHermesBrokerService)
```

The adapter is a peer route (verified: `meriv3-runtime.proxy.spec.ts`). The governed Context Plane wrapper still runs first, so the compiled governed prompt is available to the adapter and handed to Hermes as per-turn `instructions` (verified in the adapter; the harness runs without the Context Plane module and therefore with an empty governed prompt — labelled in evidence).

## 2. Authorization envelope (server-created; verified shape)

`MeriHermesAuthorizationEnvelope` is built by the adapter from the authenticated `TenantContext` and the Context Plane security resolver; it is stored on the run record and never sent to the model.

| Field | Source | Notes |
|---|---|---|
| `tenantId`, `actorType`, `actorId` | `TenantContext` (middleware) | actorId = Capiro user id |
| `conversationId`, `workspaceId` | owned conversation row (tenant + user + not archived) | 404 otherwise |
| `executionScopeId` | `tenant:<tenantId>:user:<userId>` | Phase 0 private scope; a shared room gets its own scope id later |
| `audience` | `private` | `room` / `tenant` reserved |
| `authorizedClientIds`, `authorizedMailboxConnectionIds` | `securityEnvelope(ctx)` (clients with `memoryWall=false` or a `ClientMemoryAccess` grant; mailbox connections owned by the actor) | same resolver the Context Plane uses |
| `toolPolicy` | server constant for Phase 0: the six broker tools, `readOnly=false` | broker enforces allow/deny/readOnly per call |
| `authorizationVersion` | `v1:` + sha256(role, sorted client ids, sorted mailbox ids)[0:16] | changes when grants/role change |
| `runId`, `traceId`, `issuedAt`, `expiresAt`, `budget` | adapter | budget: 40 tool calls, 8 000 output tokens, `MERI_HERMES_RUN_MAX_WALL_MS` |

Rechecks (verified in code + harness ISO4): the broker re-verifies on **every** worker call — token signature/expiry, run binding by Hermes run id, tenant/actor/scope equality, run liveness, envelope expiry, `authorizationVersion` equality, and **current** active membership via Prisma. A membership removal therefore fences the next tool call (403 `authorization_revoked`) even mid-run; a grant change changes the version and produces `authorization_version_mismatch`. Proposed for Phase 1: on either failure the broker also requests `stop` on the Hermes run and marks the Meri run `interrupted` with reason `authorization_downgrade`, then a fresh attempt is rebuilt from filtered context (plan §4). Checking the next tool call cannot remove already-loaded context — hence stop-and-rebuild, not filter-and-continue.

Worker credential (verified: `meri-hermes-worker-token.ts` + spec): `mhw1.<claims>.<hmac>`, ≥32-char signing key, TTL ≤12 h, claims = scope, tenant, actor, authorization version. It is proof of scope only; permissions are re-resolved server-side.

## 3. Run lifecycle (verified state machine)

```
queued → provisioning → running ─┬─▶ completed
                                 ├─▶ waiting_for_approval ──▶ running (POST …/approval) | cancelled (stop)
                                 ├─▶ waiting_for_clarification ──(turn ends)──▶ completed; answer = next message
                                 ├─▶ cancelling ──▶ cancelled
                                 └─▶ failed | interrupted | expired
```

| Concern | Contract | Status |
|---|---|---|
| Submission | `streamMessage(ctx, conversationId, body, sse, signal, mode, attachmentIds)`; user message persisted first; `turn_accepted{messageId}` emitted | verified |
| Idempotency | key `meri:<userMessageId>` passed as Hermes `Idempotency-Key`; Meri run store dedupes per scope; a resubmit **reattaches** instead of creating a second run | verified (store spec; adapter path) |
| Detach vs stop | browser disconnect → run `detached=true`, consumption continues on Meri's own controller, assistant message persisted at terminal; **only** `POST /api/clio/hermes/runs/:id/stop` cancels (Hermes `/stop` → hard interrupt) | verified in code; harness D6a/D6b |
| Reconnect | `GET /api/clio/hermes/runs/:id/events?after=<seq>` replays public frames with `seq > cursor`, then streams live until terminal; pending interactions are replayed because they are ordinary events | verified in code; harness D5a/D6b |
| Waiting states | `waiting_for_approval` (live process; Hermes blocks until `/approval`), `waiting_for_clarification` (durable; run finishes, answer arrives as next message and is prepended to the next run input) | verified in code; harness D5 |
| Errors | admission failure → `error` frame + persisted failure receipt (`finishReason:'error'`, `partial:true`); stream ended without terminal → status reconciliation (6 polls) → else `interrupted`; **no fallback** to V3/legacy | verified (proxy spec; adapter) |
| Usage | `run.completed.usage` → `usage` frame + run record + message metadata (`inputTokens/outputTokens/totalTokens`); cost_usd not on Hermes' wire (computed in its state.db) | verified |
| Wall-clock budget | timer → `requestStop` → terminal `expired` | code |
| One authoritative executor for business actions | Hermes never executes Meri business actions; Phase 0 exposes only reads, a governed memory **candidate**, artifact publication and clarification. Business writes (email, tasks, client records) remain with `MeriActionProposal` + Meri's executor; a worker would obtain a *proposal id*, never execute (Phase 1/4) | proposed |
| Unknown external outcome | broker mutating calls carry the run id + tool name as the idempotency key (`memory.propose` is idempotent by candidate dedupe; artifacts by sha256 metadata); unknown outcomes are surfaced as `outcome_unknown`, never retried blindly | partially verified (dedupe), rest proposed |

## 4. Event contract

### 4.1 Hermes wire → Meri durable event → browser frame (verified in `meri-hermes-event-translator.ts` + spec)

| Hermes `/v1/runs/{id}/events` | Meri `MeriHermesRunEvent.kind` (visibility) | Meri SSE frame(s) to the browser |
|---|---|---|
| `message.delta{delta}` | `message.delta` (public) | `{type:'text', text}` |
| `tool.started{tool,preview}` | `tool.started` (public) | `{type:'tool_call', tool, label}` |
| `tool.completed{tool,duration,error}` | `tool.completed` (public) | `{type:'sources', sources:[{tool,label,count:null,summary,confidence}]}` |
| `subagent.start` / `subagent.complete` | `subagent.started/completed` (public) | `tool_call` / `sources` for `delegate_task` |
| `reasoning.available` | — (dropped) | — |
| `approval.request{request_id,command,description,choices}` | `approval.requested` (public) + pending interaction `live_process` | `{type:'pending_approval', runtime:'hermes', proposalId:'hermes:<runId>:<requestId>', interaction:{requestId,choices,continuation}}` |
| `approval.responded` | `approval.resolved` (public) | — |
| `run.steered` | `steer.accepted` (internal) | — |
| `run.stopping` | `run.status` (public) | — |
| `run.completed{output,usage}` | `run.completed` (public) | `{type:'usage'}` then adapter `done` |
| `run.failed{error}` | `run.failed` | `{type:'error'}` then `done{finishReason:'error',partial:true}` |
| `run.cancelled` / `run.interrupted` | same | `done{finishReason:'aborted'|'interrupted', partial:true}` |
| unknown | `run.status` (internal, `unknownWireEvent`) | — |

Broker-originated events (verified in code; harness D4/D5a): `artifact.published` → `{type:'artifact', artifact:{id,title,kind,bodyText?,downloadUrl:'/api/clio/hermes/artifacts/:id'}}`; `clarification.requested` → `{type:'clarify', runtime:'hermes', requestId, questions:[…], continuation:'durable_continuation'}`; `memory.proposed`, `memory.recalled` (internal, counts only).

Meri-originated frames: `turn_accepted`, `start{runtime:'hermes', runId}`, `done{runtime:'hermes', runId, model, finishReason, partial, messageId, contextPacketId?, pendingInteractions?}`, `error`, `progress{phase:'reconnect'}` on reconnect. Every public event payload carries `frames[]`, which is what reconnect replays.

### 4.2 Sequenced durable log (verified prototype, in-memory)

`MeriHermesRunEvent{seq, runId, at, kind, visibility, payload}`; `seq` is monotonic per run from 1; cap 5 000 events per run with a marked gap; TTL sweep of terminal runs (24 h). Phase 1 replaces `MeriHermesRunStore` with Prisma tables (see §7) behind the same `MeriHermesRunRepository` interface.

## 5. Control surface (verified routes)

| Route | Guard | Purpose |
|---|---|---|
| `GET /api/clio/hermes/capabilities` | RolesGuard + pilot gate (404 outside pilot) | build pins, Hermes feature flags, toolsets, adapters required |
| `GET /api/clio/hermes/runs/:runId` | pilot gate + **owner** (tenant + actor) else 404 | safe projection incl. pending interactions |
| `GET /api/clio/hermes/runs/:runId/events?after=` | same | reconnect / replay SSE |
| `POST /api/clio/hermes/runs/:runId/stop` | same | explicit cancel |
| `POST /api/clio/hermes/runs/:runId/approval {requestId, decision: approve_once|deny}` | same | resolve native approval (`once`/`deny` on Hermes) |
| `POST /api/clio/hermes/runs/:runId/clarification {requestId, answer}` | same | record answer; UI sends it as the next message |
| `POST /api/clio/hermes/runs/:runId/steer {text}` | same | Hermes `/steer` |
| `GET /api/clio/hermes/artifacts/:artifactId` | pilot gate + owner | download a Hermes-published artifact |
| `POST /api/internal/hermes/broker/{memory/recall, memory/propose, artifacts, clarifications, turns}`, `GET …/attachments/:id`, `GET …/whoami` | worker token + `x-meri-hermes-run-id` | broker (worker-facing only) |

## 6. UI / command mapping

Legend: **native** = Hermes provides it over the pinned API; **adapter** = Meri must add the listed piece; **P0/P1/…** = phase in which the Meri control ships. Request identifier = what routes the user's answer to the right run.

| Capability | Meri control / command | Runtime API / event | Request id | Durable state (Meri) | Completion / error behaviour | Phase |
|---|---|---|---|---|---|---|
| Send a turn | existing composer | `POST /v1/runs` (via adapter) | `runId` (Meri) ↔ `hermesRunId` | run record + `clio_messages` | `done{finishReason}`; misconfig/unreachable → `error`+`done`, no fallback | P0 verified |
| Stop | existing Stop button → **new** `POST …/runs/:id/stop` (today Stop only aborts the fetch = detach) | `POST /v1/runs/{id}/stop` | runId | `stopRequestedAt`, status `cancelling→cancelled` | `done{finishReason:'aborted'}`; cancelled runs never publish success | P0 verified (endpoint), P1 (button wiring) |
| Leave page / reconnect | **new**: on mount, `GET …/runs/:id/events?after=<lastSeq>` for the conversation's active run | Meri replay | runId + `seq` cursor | event log | replays pending interactions | P0 verified (endpoint), P1 (UI) |
| Tool / subagent progress | existing trust-step cards (`tool_call` → `sources`) | `tool.started/completed`, `subagent.*` | — | events | previews truncated 500 chars, redacted upstream | P0 verified |
| File upload / ingestion | existing attachment upload (`POST /api/clio/attachments`) → attachment ids on the turn | adapter: `meri_fetch_attachment` (broker `GET attachments/:id`) then native `read_file` (PDF/DOCX extraction) | attachment id | `ClioAttachment` (bytes + app-side text) | tool result names the workspace path; Hermes API has **no** upload path (`unsupported_content_type`) | P0 verified (harness D4) |
| Rich artifact preview / download | existing artifact card + **new** download route | adapter: `meri_publish_artifact` → `artifact.published` frame; `GET /api/clio/hermes/artifacts/:id` | artifact id | `ClioArtifact` (inline ≤2 MiB in Phase 0; S3 via existing docgen storage in P1) | owner-scoped; other user 404 | P0 verified (D4); P1 storage |
| Clarification question | **new** inline question card (reuse research `clarify` renderer) | adapter: `meri_request_clarification` → `clarify` frame; answer = next message or `POST …/clarification` | `requestId` (`clar_…`) | pending interaction `durable_continuation` | run completes; next message resolves and is prefixed with the question context; survives reconnect | P0 verified (D5a); P1 UI |
| Approval / denial (native Hermes guard) | **new** approval card variant (`pending_approval` with `runtime:'hermes'`) → `POST …/runs/:id/approval` | native `approval.request` / `POST /v1/runs/{id}/approval` (requires worker env `HERMES_EXEC_ASK=1`; otherwise auto-deny) | `request_id` | pending interaction `live_process`, status `waiting_for_approval` | deny → tool blocked, run continues; approve_once → runs; stop while pending → cancelled; times out after `approvals.timeout` (300 s) | P0 (harness D5b–d); P1 UI + retained-worker lifecycle |
| Approval for **Meri business actions** (email, tasks, client writes) | existing `MeriActionProposal` cards | adapter (P1/P4): worker tool returns a proposal id; Meri executor runs the approved payload; Hermes receives a receipt on continuation | proposal id | `meri_action_proposals` | denied/expired never executes at the broker | P1/P4 proposed |
| Session recall | existing history load; **new** "continue from history" is automatic: conversation ↔ Hermes `session_id` binding stored in `clio_conversations.metadata.hermes.sessionId`. **Rule (found in D6c):** the `X-Hermes-Session-Key` names the Hermes *transcript*, so it is `tenant:<t>:user:<u>:conversation:<conversationId>` — one Hermes session per Meri conversation. A per-user key merged all of a user's conversations into one transcript. The `/v1/runs` acceptance body carries no `session_id`; the adapter reads it from `GET /v1/runs/{id}` right after admission. | `POST /v1/runs{session_id}`, `GET /api/sessions/{id}/messages` | session id | conversation metadata + Hermes `state.db` in scope volume | new worker on same volume continues the session (D6c) | P0 verified |
| Fork / regenerate | existing Regenerate/Resend (mode `regenerate`/`resend` supported by the adapter) → P1: `POST /api/sessions/{id}/fork` | `session_fork` | session id | conversation metadata | Meri deletes/updates messages as today | P0 (modes), P1 (native fork) |
| Steer | **new** "add guidance" while running (composer copy currently promises this; MW-09) | `POST /v1/runs/{id}/steer` | runId | event `steer.accepted` | 409 when not running | P0 endpoint, P1 UI |
| Skill visibility / management | **new** settings tab listing scope skills (from the worker filesystem via broker/ops API; Hermes `/v1/skills` is broken on this build) and learning receipts (`background_review` usage) | `skills_list`/`skill_view`/`skill_manage` tools; filesystem | skill name | scope volume `skills/`; P1 registry | — | P1/2B |
| Tenant persona / private style | **new** settings: tenant persona (renders SOUL.md → `MERI_SOUL_B64`), private preferences (memory provider propose scope `user_private`) | SOUL.md at worker start; `/personality` overlay not exposed over `/v1/runs` | — | tenant settings (versioned) + memory items | takes effect at next worker start / session boundary | P1/2B |
| Memory recall / remember / forget | existing memory UI + `remember` via `meri_memory_propose` (candidate) | provider `prefetch`, tools `meri_memory_search/propose` | candidate id | `memory_candidate` / `memory_items` (governed) | shared scopes always pending review | P0 verified (D2) |

## 7. Proposed durable records (Phase 1 ticket 3, additive)

| Table | Key fields |
|---|---|
| `meri_execution_scopes` | id, tenant_id, principal_type/id, kind (`private`/`room`), authorization_version, home_volume_ref, persona_version, worker_state, created/updated |
| `meri_agent_runs` | id, tenant_id, scope_id, actor_id, conversation_id, user_message_id, assistant_message_id, hermes_run_id, hermes_session_id, status, finish_reason, partial, idempotency_key (unique per scope), envelope_jsonb (no secrets), usage_jsonb, budget_jsonb, detached, stop_requested_at, created/finished |
| `meri_agent_run_events` | run_id, seq (unique per run), kind, visibility, payload_jsonb (frames), at |
| `meri_agent_interactions` | run_id, request_id (unique per run), kind, continuation, prompt, choices, created, expires, resolution_jsonb |
| `meri_worker_leases` | scope_id, task_arn/container, lease_owner, lease_expires_at, image_digest, health, started/finished |
| `meri_skill_registry` | scope_id, name, version, bundle_hash, audience, provenance_jsonb, promoted_from, created_by_run |
| `meri_artifacts` (or reuse `clio_artifacts` + S3 key) | as today plus run_id, sha256 |

Every table carries `tenant_id`; ids never substitute for authorization (owner checks stay in the services).

## 8. Persona contract (SOUL.md)

Meri renders the tenant's versioned persona to a SOUL.md string and passes it as `MERI_SOUL_B64` at worker start (verified mechanism in `entrypoint.sh`; fixture persona in `SOUL.template.md`). Rules: persona changes are versioned and apply at worker (re)start; private user style preferences are memory items (`user_private`) recalled via the provider, never edits to the tenant SOUL; subagents do not inherit SOUL.md (`skip_context_files=True` in `delegate_tool.py`) — Phase 1 must inject business identity into delegated tasks explicitly.
