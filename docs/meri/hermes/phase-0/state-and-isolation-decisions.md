# Decisions: durable profiles, memory, skills, isolation, worker lifecycle, scheduling

Prepared September 19, 2026. Each decision names the evidence that supports it (harness check ids refer to `checks-report.md`; source anchors refer to the pinned Hermes tree and this branch).

## 1. Authoritative state map

| State | Owner (single writer) | Where it lives | Restart / replacement behaviour | Revocation / retention |
|---|---|---|---|---|
| Conversation transcript | **Meri** (`clio_messages`) | Postgres | independent of workers; Hermes messages persisted with `metadata.runtime='hermes'` (D6b) | existing conversation retention |
| Hermes session (native history, compression checkpoints) | Hermes `state.db` on the **scope volume** | `HERMES_HOME/state.db` (27 tables incl. `sessions`, `messages`, `session_model_usage`, `async_delegations`) | survives container replacement on the same volume (D6c); conversation ↔ `session_id` binding stored in `clio_conversations.metadata.hermes.sessionId`; session key is per Meri conversation (`…:conversation:<id>`), never per user, because the key names the transcript | deleting a conversation must also mark the Hermes session archived (P1); volume deletion on scope teardown |
| Institutional facts | **Meri** governed memory (`memory_items`, `memory_candidate`) | Postgres | provider recall via broker (D2a); writes are candidates (D2b) | existing governance; built-in MEMORY.md/USER.md **disabled** (`memory.memory_enabled=false`, `user_profile_enabled=false`) so no second source of truth |
| Personality | **Meri** tenant persona (versioned) → rendered SOUL.md | worker volume `SOUL.md`, re-rendered from `MERI_SOUL_B64` at start | identical after replacement (D3c) | new version applies at next worker start |
| Skills (SKILL.md bundles) | Hermes writes; **Meri registry** records versions (P1) | scope volume `skills/` (`skills.create_dir`) | preserved across replacement (D3c) | private scope by default; promotion is a Meri policy step (P2B) |
| Working files / attachments materialised / artifacts produced | worker scope volume `workspace/`; **published** copies are Meri `ClioArtifact` rows (owner scoped) | volume + Postgres (inline ≤2 MiB in P0; S3 in P1) | volume persists; unpublished files are scratch | scratch purged on scope teardown; artifacts follow conversation retention |
| Browser profiles / cookies | worker volume (`HERMES_HOME/browser_*`) | scope volume | per scope, never shared across users | purged on teardown |
| Run status, events, pending interactions | **Meri** run repository | P0: process memory (`MeriHermesRunStore`); P1: Prisma tables | P0: API restart loses live runs → `interrupted`; P1: durable | TTL sweep 24 h (P0) |
| Cron / heartbeat / goals | **Meri scheduler** (decision below) | Meri job tables | Hermes' own cron thread only runs while its gateway process is alive | Meri jobs reauthorized at fire time |

## 2. Isolation model

- **One execution scope = one Hermes home = one worker** (`tenant:<tenantId>:user:<userId>` in Phase 0). Profiles are not a sandbox (upstream docs; structural evidence in `hermes-source-evidence-b.md` §18); isolation is the container/task boundary plus a per-scope volume. A used home is never reassigned to another user; a new scope gets a fresh volume.
- Shared rooms need a **separate scope kind** (`room`) with its own home once membership exists; a private scope's files, cookies and sessions never appear in a room scope.
- The worker holds only: `API_SERVER_KEY` (inbound), the scope-bound worker token (outbound to the broker), a model credential, the persona. No platform secrets, no DB credentials, no connector tokens (verified by the container env in the harness; `whoami` shows the scope binding).
- Cross-user and cross-tenant evidence: ISO1–ISO4 (run ownership, gate, spoofed identity, broker token misuse) plus D2c (Bob cannot recall the walled client or Alice's private fact).

## 3. Worker lifecycle (decision for Phase 1 design)

| Event | Behaviour |
|---|---|
| First turn for a scope | Meri provisions the worker (P1: Fargate `RunTask` from the pinned digest, scope volume attached), mints the worker token, waits for `/health`; the browser sees `start` after `progress` frames. Measured cold start on the local host: see `measurements.md`. |
| Idle | Keep warm for a scope-configurable grace period only after a **completed or parked** turn with no active goal, child, process, pending live interaction or unfinished background review (`/health/detailed` exposes `active_agents`, `background_queues`). |
| Teardown | Persist skills/session (already on the volume), stop the task; pending background review must be allowed to finish or be re-queued — Hermes runs it as a daemon thread in the gateway process after the turn (source §5), so a hard stop right after `run.completed` loses it. Rule: wait for `background_queues` idle or a bounded grace (P1). |
| Mid-turn loss | Meri marks the run `interrupted` after status reconciliation fails; recovery is a **fresh attempt** from Meri history + tool receipts, never a promise of mid-process restore (D6c note). |
| Replacement (image upgrade) | Same volume, new container: persona, skills and sessions carry over (D3c/D6c). |
| Warm capacity | Not decided by Phase 0; measure per-scope idle cost first (`measurements.md`). |

## 4. Memory integration decisions

1. Provider = `meri_memory` (external, single). `prefetch` → broker recall (governed, honest empty on failure — no local fallback); tools `meri_memory_search` / `meri_memory_propose`; `sync_turn` posts a receipt only.
2. Writes are **candidates** through `MemoryCandidateService.proposeSaveMemory(…, isAdmin=false, 'model_extraction')`: personal scope follows the existing PASS rule; firm/client scopes always pend for the existing review queue. The runtime is never an admin (D2b).
3. Production recall path = `ContextPlaneRecallPort` (`searchCapiroData` → `institutional_knowledge` rail); harness path = `DirectMemoryItemsRecallPort` with the same predicates, labelled `direct_memory_items_prototype` in every result.
4. Governed-lifecycle dark mode (`MEMORY_GOVERNANCE_LIFECYCLE` unset) is handled: suppression SQL is empty; enforcement adds the predicate. Policy tests before enabling writes in production remain a Phase 2 gate.

## 5. Skills and automatic learning

- Explicit creation works natively over `/v1/runs` (`skill_manage`) and persists on the scope volume (D3b); reuse after replacement works (D3c).
- Automatic learning is the native **background review**: a daemon thread in the gateway process, spawned after a turn once `_iters_since_skill ≥ 10` (source §5), using ~30K tokens per event, enabled by `auxiliary.background_review.enabled` (default true, pinned to the Meri model in the worker config). D3d records whether it fired in one short task; the threshold means a single short task usually does not trigger it — this is expected behaviour, not a defect. Curator = weekly housekeeping tick after 2 h idle (source §5).
- Lifecycle integration required (P1/2B): keep the worker alive until the review finishes; record review usage (`session_model_usage task='background_review'`) into Meri accounting; register new/changed bundles in the skill registry with provenance; promotion to room/tenant audience via Meri policy; `skills.write_approval` staging is available if a tenant wants review before activation.
- `GET /v1/skills` is broken on this build (TypeError) — Meri lists skills from the volume/registry, not from that endpoint.

## 6. Scheduling ownership (decision)

Meri owns scheduling. Evidence: Hermes cron/heartbeat/goals/kanban watchers run inside the gateway process and stop when it stops (source §12); the existing Meri scheduler (`run-clio-scheduled-tasks.ts`) lacks an atomic occurrence claim and fails open on membership lookups, so it must not be reused as-is (audit). Phase 1/5 builds proactive jobs on the house pattern that already exists: Postgres outbox + `FOR UPDATE SKIP LOCKED` lease + fenced terminal writes (`DefenseBudgetIngestionOutbox`, `MemoryCleanupOutbox`, `meri-research-run-state.ts` read-time lease expiry), with an EventBridge rule waking a small dispatcher that provisions/wakes the scope worker and submits a `/v1/runs` turn. Hermes' `/api/jobs` and `cronjob_manage` stay disabled for pilot scopes (`jobs_admin: false` today).

## 7. Approvals and clarification

- Native approvals over `/v1/runs` are **auto-denied** unless the worker runs with `HERMES_EXEC_ASK=1` (`approvals.unattended_mode` default deny on the `api_server` platform, `tools/approval_context.py:134`). With the switch, the run blocks (`waiting_for_approval`) until `POST /v1/runs/{id}/approval` — a **live retained process** interaction bounded by `approvals.timeout` (300 s). Decision: keep native approvals for worker-local guarded commands only; Meri business actions go through `MeriActionProposal` with Meri as the single executor (P1/4).
- Clarification has **no native path** over `/v1/runs` (no `clarify_callback`; tool not in the default toolset). Decision: the `meri_request_clarification` adapter with **durable continuation** (turn ends; answer is the next message), which also avoids retaining a blocked worker (D5a).

## 8. Architecture changes driven by evidence

- Add an explicit **worker provisioning/lifecycle service** and **scope volume** to the diagram (the plan's "Hermes workers" box hides both).
- Add `HERMES_EXEC_ASK` / approvals mode as a worker configuration concern; approvals are not a free property of the API.
- Replace "Hermes cron" with "Meri scheduler wakes workers" in the async lane (already the plan's intent; now evidenced).
- Broker credentials: scope-bound worker tokens, not run-bound tokens (a run-bound token cannot reach a plugin because tool calls receive only the Hermes run id via contextvar; binding is done server-side by run id → scope). Updated `architecture.mmd` in this folder reflects these.
