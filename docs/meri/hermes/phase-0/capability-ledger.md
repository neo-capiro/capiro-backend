# Capability ledger — full Hermes experience inside Meri

Prepared September 19, 2026. Pinned build: Hermes `v2026.9.14` (0.21.3), image `meri-hermes-worker:v2026.9.14-meri`. Source anchors are in `hermes-source-evidence-a.md` (§1–10) and `hermes-source-evidence-b.md` (§11–20); live results in `checks-report.md` and `evidence/<run>/`.

Status vocabulary (one per row):

- **verified** — exercised end-to-end in this branch (harness check id given) or by unit tests.
- **adapter required** — the capability exists on the build but Meri must add the listed piece before advertising it; the requirement is not dropped.
- **unverified** — present in source/config, not exercised in Phase 0.
- **unsupported on this build/backend** — evidenced as absent or broken for the `api_server` platform / container backend.

Columns: interface = how Meri reaches it on the pinned build; native / integration / end-to-end distinguish what Hermes provides, what Meri built, and what was actually tested.

## A. Runtime core

| Capability | Interface (pinned build) | Native | Meri integration (this branch) | End-to-end evidence | Status | Remaining work / owner / phase |
|---|---|---|---|---|---|---|
| Agent loop, multi-step tool use | `POST /v1/runs` + `GET /v1/runs/{id}/events` | yes (`api_server_runs.py`) | `MeriHermesRuntimeAdapter`, `MeriHermesRuntimeClient` | D1 | **verified** | Prisma-backed run store (P1 t3) — backend/platform |
| Streaming text + public tool progress | `message.delta`, `tool.started/completed` SSE | yes | translator → `text`, `tool_call`, `sources` frames | D1 | **verified** | UI polish only |
| Cancel | `POST /v1/runs/{id}/stop` (hard interrupt) | yes | `POST /api/clio/hermes/runs/:id/stop`; cancelled runs never publish success | D6a, D5d | **verified** | wire Stop button to the endpoint (today Stop = fetch abort) — frontend P1 |
| Browser detach ≠ stop | none native (event buffer TTL 300 s) | partial | adapter consumes on its own controller; `detached` flag; replay `?after=seq` | D6b | **verified** (single API process) | durable events across API restart/replicas (P1 t3) |
| Idempotent submission | `Idempotency-Key` (durable 24 h) | yes | `meri:<userMessageId>`; store dedupe; resubmit reattaches | unit (store); D1 path | **verified** | — |
| Status polling | `GET /v1/runs/{id}` (status TTL 3600 s) | yes | status reconciliation after stream end; `GET /api/clio/hermes/runs/:id` | D6b | **verified** | — |
| Steer mid-run | `POST /v1/runs/{id}/steer` (409 unless running) | yes | `POST /api/clio/hermes/runs/:id/steer` | not exercised live | unverified | harness case + composer "add guidance" (MW-09) — P1 |
| Concurrency limit | `gateway.api_server.max_concurrent_runs` (429) | yes | worker config `MERI_MAX_CONCURRENT_RUNS` | not exercised | unverified | per-tenant fair queue in the lifecycle service — P1/6 |
| Usage accounting | `run.completed.usage` (tokens only; `estimated_cost_usd` stays in `state.db`) | partial | usage → run record + message metadata; measurements | D1, measurements | **verified** (tokens) | cost from provider price sheet; include background review/delegation usage (`session_model_usage`) — P1 |
| Failure surfacing, no fallback | — | — | error frame + failure receipt; proxy spec | unit (proxy spec) | **verified** | — |

## B. Identity, authorization, data

| Capability | Interface | Native | Meri integration | Evidence | Status | Remaining work |
|---|---|---|---|---|---|---|
| Server-side pilot gate (3 keys, canonical tenant id) | — | — | `meri-hermes-flags.ts`, `isMeriHermesRuntimeEnabled`, proxy routing | unit (6 tests), ISO2, ISO5 | **verified** | apply to deployed env (later phase) |
| Spoof rejection | — | — | tenant id only from `TenantContext`; body/slug ignored | unit, ISO3 | **verified** | — |
| Authorization envelope | — | — | server-created, stored on run, never sent to model | code, D1 | **verified** | room/audience fields when rooms exist (P3) |
| Scope-bound worker credential | — | — | `mhw1` HMAC token, ≤12 h, scope+authorization version | unit (4 tests), ISO4 | **verified** | provisioning service mints/rotates (P1) |
| Per-call re-authorization (token, run binding, liveness, version, current membership) | — | — | `MeriHermesBrokerService.authorize` | ISO4 | **verified** | stop-and-rebuild on downgrade (P1) |
| Tool policy per run (allow/deny/readOnly/budget) | — | — | `assertTool` | code | **verified** (unit-level via broker) | policy from tenant settings (P1) |
| Institutional memory recall (authoritative in Meri) | provider `prefetch` + tool `meri_memory_search` | provider hooks exist (`agent/memory_provider.py`) | `meri_memory` plugin → broker → `ContextPlaneRecallPort` (prod) / `DirectMemoryItemsRecallPort` (harness) | D2a, D2c | **verified** (harness path) | run against the Context Plane rail in the full API (P1) |
| Memory write = governed candidate | tool `meri_memory_propose` | — | `MemoryCandidateService.proposeSaveMemory(isAdmin=false,'model_extraction')` | D2b | **verified** | policy tests before enabling in prod (P2) |
| Built-in MEMORY.md/USER.md disabled, SOUL.md + skills native | `memory.memory_enabled/user_profile_enabled=false`, `memory.provider` | yes | worker config template | D3a, D2 | **verified** | — |
| Comprehensive authorized data access (549 models) | none native | — | inventory + `discover/describe/query/read_record/read_related/export` design; coverage `--check` prototype | data-inventory (340-model gap) | **adapter required** | Phase 2A gateway + catalog annotations — backend/data owners |
| Existing native Meri tools via broker | — | — | not exposed in Phase 0 (audit found missing actor/client checks) | audit | **adapter required** | session pin + wall check at broker before reuse (P2) |
| MCP connectors (personal/firm, OAuth, chat-only managed apps) | Hermes has its own MCP client (`tools/mcp_tool*`) | yes (native) | not wired; decision: broker facade over Meri's `MeriMcpService` | audit | **adapter required** | broker MCP facade preserving surface restrictions (P2) |
| Indexed email tools | — | — | not wired | audit | **adapter required** | broker exposure of `list/search/get_email_thread` with mailbox selection (P2) |

## C. Personality, skills, learning

| Capability | Interface | Native | Meri integration | Evidence | Status | Remaining work |
|---|---|---|---|---|---|---|
| SOUL.md personality | `HERMES_HOME/SOUL.md` (identity slot #1) | yes | rendered from `MERI_SOUL_B64` at worker start | D3a, D3c | **verified** | tenant persona settings UI + versioning (P2B) |
| Session personality overlay (`/personality`) | slash command in CLI/gateway chats | yes | not exposed | source | unverified | decide whether `/v1/runs` input dispatches slash commands (P1 spike) |
| Explicit skill creation (`skill_manage` create/patch/write_file) | tools in default `hermes-api-server` toolset | yes | none needed; persisted on scope volume | D3b | **verified** | registry + versions (P2B) |
| Skill reuse after worker replacement | filesystem | yes | scope volume per execution scope | D3c | **verified** | registry-driven materialisation (P2B) |
| Automatic learning (background review) | daemon thread after a turn when `_iters_since_skill ≥ 10`; `auxiliary.background_review.*` | yes, runs on `api_server` | pinned to Meri model in worker config | D3d (observed) | **verified mechanism / observed** | keep worker alive until review completes; capture usage; registry hook (P1/2B) |
| Curator (weekly consolidation) | gateway housekeeping tick (2 h idle, 7-day cadence) | yes | none | source §5 | unverified | requires long-lived scope worker or Meri-triggered `hermes curator` (P2B) |
| Skill write staging / approval | `skills.write_approval` → `HERMES_HOME/pending/`, `/skills approve` | yes | off in pilot | source | unverified | tenant policy option (P2B) |
| Skill listing over API | `GET /v1/skills` | **broken** (`TypeError … include_editorial`) | list from volume/registry instead | CAPS, D3b | **unsupported on this build** | upstream fix or Meri registry (P2B) |
| Skill promotion to room/tenant audience | none native (`external_dirs` is discovery, not protection) | — | policy design in decisions doc | — | **adapter required** | registry + snapshots (P2B) |

## D. Interactions and files

| Capability | Interface | Native | Meri integration | Evidence | Status | Remaining work |
|---|---|---|---|---|---|---|
| Native approval over API | `approval.request` event + `POST /v1/runs/{id}/approval`; **blocks only with `HERMES_EXEC_ASK=1`** (else auto-deny via `approvals.unattended_mode`) | yes, conditional | `pending_approval{runtime:'hermes'}` frame; `POST …/approval`; pending interaction `live_process` | D5b (deny → tool BLOCKED), D5c (approve once → ran), D5d (stop while waiting → cancelled) | **verified** (requires `HERMES_EXEC_ASK=1`; Meri exposes only once/deny) | UI card + bounded retained-worker lifecycle (P1/4); Meri business actions stay with `MeriActionProposal` |
| Clarification | `clarify` tool has no callback on `api_server` (not in default toolset) | **unsupported natively** | `meri_request_clarification` durable continuation | D5a | **verified (adapter)** | clarify card in UI (P1) |
| File ingestion | API rejects `file`/`input_file` (`unsupported_content_type`); `/v1/artifacts/upload` is browser-control only | **unsupported natively** | `meri_fetch_attachment` → workspace → native `read_file` (PDF/DOCX extraction) | D4 | **verified (adapter)** | S3-backed originals via existing attachment pipeline (P1) |
| Artifact retrieval | none native over API (files stay in the worker) | — | `meri_publish_artifact` → `ClioArtifact` → `GET /api/clio/hermes/artifacts/:id` (owner-scoped) | D4 (Alice 200 / Bob 404) | **verified (adapter)** | S3 storage, preview kinds, docgen parity (P1/3) |
| Rich media (image gen, vision, TTS/STT, video) | toolsets exist; providers need keys; `MEDIA:` inlining only on `/api/sessions/*/chat` | conditional | not wired | source §13 | unverified | provider decisions + delivery mapping (P5A) |
| Session recall / continuity | `session_id`, `X-Hermes-Session-Key` (names the transcript), `GET /api/sessions/{id}/messages`; acceptance body carries no `session_id` (read from `GET /v1/runs/{id}`) | yes | conversation ↔ session binding in metadata; session key **per Meri conversation** | D6c re-run (`run_180fae92…`, history 200, continuation correct) | **verified** | archive on conversation delete (P1) |
| Fork / regenerate | `POST /api/sessions/{id}/fork`; Meri modes regenerate/resend | yes / yes | adapter supports modes; fork not wired | code | unverified (fork) | fork mapping + transcript semantics (P3) |
| Compression / context management | `compression.*` (threshold 0.50, tail 0.20) | yes | pinned to Meri model | source §15 | unverified | durable checkpoint hooks (`on_pre_compress`) — P1 |

## E. Delegation, specialists, background work

| Capability | Interface | Native | Meri integration | Evidence | Status | Remaining work |
|---|---|---|---|---|---|---|
| Temporary subagents (`delegate_task`) | in default toolset; children `skip_context_files=True` (no SOUL.md), depth 1, ≤10 | yes | events `subagent.start/complete` translated | translator unit | unverified live | propagate identity/audience to children explicitly; account child usage (P5A) |
| Detached (async) delegation delivery | forced sync without a bound session; results "wake" only when the client posts a follow-up run with the same session (#98619) | partial | none | source §7 | **adapter required** | Meri continuation/notification path (P5/5A) |
| Persistent specialists / Bot Mode | `message_agent` only in a session titled exactly `Bot Chat` with a profile carrying `ui_meta.hermes-bots`; `hermes peer run` = `POST /v1/runs` on that session | yes, conditional | none | source §11 | **adapter required** | named specialist scopes, roster, attribution, receipts (P5A) |
| Hosted rooms / cross-machine delivery | gateway room authority fenced by `authority_gateway_id/epoch`; `Authorization: HermesRoom` grants | yes | none | source §11 | unverified | evaluate vs Meri rooms (P3/5A) |
| Goals / heartbeat / loops | gateway slash commands + in-process pollers | yes | none | source §12 | unverified | slash dispatch over `/v1/runs` spike; Meri-owned budgets (P5) |
| Cron / scheduled jobs | `cron/` 60 s tick in the gateway process; `/api/jobs` (`jobs_admin: false`), `/api/cron/fire` | yes | **decision: Meri scheduler owns wake** | source §12 | **adapter required** | outbox + lease dispatcher waking workers (P5) |
| Kanban / task board | plugin + gateway watchers | yes | none | source §12 | unverified | map to Meri task domain (P5) |

## F. Execution surface and platform

| Capability | Interface | Native | Meri integration | Evidence | Status | Remaining work |
|---|---|---|---|---|---|---|
| Terminal / files / code execution | `terminal.backend: local` inside the worker container | yes | worker config | D1 (terminal), D4 (read/write_file) | **verified** | Fargate task sizing, egress policy (P1/6) |
| Browser automation | agent-browser (Playwright chromium in image) / cloud providers | yes | not exercised (tools gated off until requirements met in logs) | CAPS toolsets | unverified | scope cookies per user; larger task class (P5A) |
| Checkpoints / rollback | `checkpoints.enabled` (default off); shadow git store; **no HTTP endpoint**; container-backend exclusion documented upstream, not found in source | yes (local) | off | source §16 | unverified | workspace snapshot mechanism on the scope volume (P5A) |
| Plugins and hooks | `$HERMES_HOME/plugins/<name>` + `plugins.enabled`; `register(ctx)` API | yes | two Meri plugins loaded (`hermes plugins list`: enabled/user) | CAPS, D2, D4 | **verified** | version pinning of Meri plugins in image (done), review of bundled skills' licenses (P1) |
| Model / provider routing | `model.provider` (`custom` for OpenAI endpoint), per-request `model/provider/model_options` | yes | `MERI_HERMES_MODEL/PROVIDER/BASE_URL` | D1 | **verified** | tenant model policy + fallback chain (P1) |
| Profiles as isolation | profiles are separate homes, not sandboxes | — | one scope = one container + volume | ISO checks | **verified (design)** | Fargate task per scope (P1) |
| ARM64 image for Fargate | — | — | build script supports `PLATFORM=linux/arm64`; not built | — | unverified | build + test on arm64 (P1) |
| Metrics / alarms | `/health/detailed` (readiness, active agents, queues) | yes | not wired | CAPS | unverified | CloudWatch metrics + alarms (P6) |
