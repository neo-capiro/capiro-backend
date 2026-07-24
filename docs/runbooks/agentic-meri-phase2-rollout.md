# Runbook — Agentic Meri (Strategy Planner Phase 2) rollout, retention & activation

**Status:** Neo-gated. `capiro-dev` **IS real production.** Nothing in this
runbook is executed by the coding agent — it is the operator checklist for
turning the Phase-2 agentic surfaces (Context Steward · Strategy Watcher ·
Execution Agent) on, one rung at a time, and for rolling any rung back.

**Scope of what is built (branch `feat/strategy-planner-phase2-stage-c`,
Stages A–G committed):** the full agent runtime ships **dark**. Every agentic
surface is gated by the `STRATEGY_AGENTS_ENABLED` env master switch ANDed with a
per-tenant `clioFeatureFlags` opt-in; the Watcher scheduler + outbox consumer
are additionally gated by `STRATEGY_WATCHER_SCHEDULER`; external send is
hard-disabled with no env to turn it on in this branch. Two Stage-H items are
**built and live behind the flags**: the per-tenant concurrent-run cap
(`STRATEGY_AGENTS_MAX_CONCURRENT_RUNS`, enforced in `RunsService.createRun`) and
the run cost/latency + prompt/model metric stamp (every run persists
`run.findings.metrics` via the pure `stampRunMetrics`; see §2.1 and §7). The
remaining Stage-H items (`agent_run_id` on `ai_usage`, uniform per-run logger
context) are **docs + seams** at time of writing — those seams are called out
explicitly below and must not be read as live behavior.

All AWS commands: `--profile capiro-dev`, region `us-east-1`, account
`967807252336`. Deploy mechanics (CI image + `ecs update-service`, taskdef
env edits via describe→munge→register→roll) are unchanged from the
`api-strategy-g1-deploy.md` runbook — this document references that path rather
than repeating it.

---

## 1. Architecture recap

**No new Fargate service. No new taskdef family.** By directive, the entire
agent runtime lives inside the **existing `capiro-dev-api-strategy` service**
(same image, same `/strategy-api` ALB rule, env additions only), and every LLM
loop lives inside the **existing `apps/meriv2-orchestrator`** (`/meri-api`).
Turning Phase 2 on is env + per-tenant-flag flips against services that are
already running — never a provisioning step.

- **In-orchestrator LLM loops** (`apps/meriv2-orchestrator/src/meri/`):
  strategy draft/assistant (`strategy/strategy-assistant.service.ts`,
  workflows `meriv2_strategy_draft` / `meriv2_strategy_edit`) and the Steward
  extractor (`steward/steward-extract.service.ts`, workflow
  `meriv2_steward_extract`). Deterministic Watcher checks make **no** LLM call;
  only context-comparison findings use a bounded interpretation call.
- **In-api-strategy agent services** (`apps/api-strategy/src/agents/`):
  `missions.service.ts`, `runs.service.ts`, `change-sets.service.ts` (with the
  pure `risk-router.ts`), `watcher.service.ts` + `watcher-checks.ts`,
  `execution.service.ts` + `execution-eligibility.ts` +
  `execution-artifact.client.ts` + pure `send-approval.ts`, and the run/mission
  state machine `run-state.ts`. Context plumbing/Steward persistence lives in
  `apps/api-strategy/src/context/` (`context-documents.service.ts`,
  `steward.service.ts`, `frontmatter.ts`, `markdown-locate.ts`,
  `current-plan-export.service.ts`).
- **In-process background loops** (NOT EventBridge, NOT `@nestjs/schedule` — no
  new deps): `watcher-scheduler.service.ts` and `outbox-consumer.service.ts`
  are plain `setInterval` Nest lifecycle hooks (`OnModuleInit`/`OnModuleDestroy`,
  `unref()`'d, re-entrancy-guarded). Both stay **dark unless BOTH**
  `STRATEGY_AGENTS_ENABLED` and `STRATEGY_WATCHER_SCHEDULER` are `'true'`. The
  scheduler claims due `sp_agent_mission` rows via `UPDATE … FROM (SELECT … FOR
  UPDATE SKIP LOCKED)` and bumps `next_run_at` in the same statement (two pods
  can never double-run a mission). The outbox consumer drains `sp_event_outbox`
  rows (written in the same tx as every strategy/node mutation via
  `VersioningService.logActivity`) and brings affected strategies' active
  cadence missions forward.
- **The 8 `sp_*` agent tables** (all `tenant_id`-scoped, RLS-enabled, additive):
  `sp_context_document`, `sp_context_fact`, `sp_context_conflict`,
  `sp_agent_mission`, `sp_agent_run`, `sp_change_set`,
  `sp_agent_permission_policy`, `sp_event_outbox`. These carry the Steward
  corpus, the run lifecycle, ChangeSet proposals, per-tenant risk knobs, and the
  transactional outbox. Node-level Stage-A additions (`sp_node.depends_on_ids`,
  `sp_node.provenance`) live on the pre-existing `sp_node` table.

**Blast-radius ceiling for the whole program:** api-strategy stays at 0.25
vCPU/512 MB. The only contemplated infra change is a task-size bump to 0.5
vCPU/1 GB (one taskdef rev, ~+$9/mo) **if** Watcher/Steward load degrades p95 —
never a new service.

---

## 2. ENV + FLAG matrix

Two layers gate every surface: **env switches** (taskdef env, flip via the
describe→munge→register→roll recipe; a taskdef roll is ~60s to steady state) and
**per-tenant `tenants.settings_jsonb.clioFeatureFlags` dotted keys** (flip via
the `capiro-dev-api-diag` run-task override, per the tenant-flag ops recipe).
Every per-tenant agentic flag is read fail-closed (absent/read-error ⇒ off) and
cached 60s in `StrategyFlagsService`, and is **ANDed with**
`STRATEGY_AGENTS_ENABLED` — the env short-circuits without a DB read when off.

### 2.1 Env switches (taskdef)

| Env var | Service | Gates | Default | Blast radius when flipped ON |
|---|---|---|---|---|
| `STRATEGY_AGENTS_ENABLED` | api-strategy | **Master kill switch.** ANDed into every agentic flag (`isAgenticFlagEnabled` short-circuits when not `'true'`) AND required by the scheduler + outbox loops. | unset (off) | Nothing turns on by itself — it only *permits* per-tenant flags to take effect. Flipping it OFF disables **every** agentic surface tenant-wide in one move (see §5). |
| `STRATEGY_WATCHER_SCHEDULER` | api-strategy | Arms **both** in-process loops (`watcher-scheduler` + `outbox-consumer`). Requires `STRATEGY_AGENTS_ENABLED='true'` as well. | unset (dark) | Background automation begins: due missions run on cadence; plan edits bring missions forward. Per-tenant `strategyWatcher.enabled` is still re-checked per claimed mission (skips quietly if off). |
| `STRATEGY_WATCHER_POLL_MS` | api-strategy | Scheduler poll interval. | 60000; floored at 15000 | Tuning only — smaller = tighter latency, more DB polls. Ignored unless the scheduler is armed. |
| `STRATEGY_WATCHER_OUTBOX_MS` | api-strategy | Outbox drain interval. | 30000; floored at 5000 | Tuning only — how fast an edit triggers a bring-forward. Ignored unless the loops are armed. |
| `STRATEGY_AGENTS_MAX_CONCURRENT_RUNS` | api-strategy | **ENFORCED (Stage H).** Per-tenant cap on concurrently-active runs, checked in `RunsService.createRun` (`resolveConcurrentRunCap`) before minting a genuinely-new run. | **20** (floored at 1; a non-numeric or ≤0 value falls back to 20) | `createRun` throws **503** (`ServiceUnavailableException`, `"too many active agent runs for this tenant — try again shortly"`) once the tenant's runs in `queued`/`planning`/`waiting_for_input`/`executing` (`CONCURRENT_RUN_STATES`) reach the cap; `ready_for_review` + terminal runs do **not** count, and an idempotent replay (same `idempotencyKey`) bypasses it entirely. **Soft** cap — count + insert are not atomic, so a burst of simultaneous creators can slightly exceed it. Raise this env to widen the ceiling; the scheduler claiming a batch of due missions is the most likely tripper. |
| `STRATEGY_EXECUTION_SEND_ENABLED` | api-strategy | The external-send seam only. `send-approval.sendEnabled` reads it; the send path throws `SEND_DISABLED_REASON` regardless. | **unset — NEVER set in Phase 2** | **Do not set.** External send stays hard-disabled until a separate security sign-off (§3 last rung). Setting it in this branch still does not send (the client has no send URL), but it must remain unset as the audit-clear boundary. |
| `STRATEGY_VERIFY_BLOCK` | api-strategy | **Stage-A pair (context).** When `'true'`, hard verifier errors block a Meri draft/assistant write (422 / unsaved-proposal fork); otherwise annotate-only. | unset (annotate-only) | Meri-authored plans with hard constraint violations stop persisting silently. Flip only once the web renders the violation/Save-anyway override UI. Manual edits stay advisory regardless. |
| `ANTHROPIC_MODEL` | meriv2-orchestrator | **Stage-A pair (context).** Orchestrator default model. Strict tool use requires a structured-outputs model (`modelSupportsStrict` allowlist; e.g. `claude-sonnet-5`). | `claude-sonnet-4-6` | Bumping to `claude-sonnet-5` enables strict tool use for the strategy loops (kills the malformed-node class). Verify via the Models-API capability check before the roll; tenant BYOK `modelOverridden` still wins per-call and strips strict when unsupported. |
| `STRATEGY_MERI_ENABLED` | api-strategy | **Phase-1 (context).** Env half of the Meri draft/assistant gate (ANDed with `strategyPlannerMeri.enabled`). | unset | Not a Phase-2 switch; listed so operators don't confuse it with `STRATEGY_AGENTS_ENABLED`. |

### 2.2 Per-tenant agentic flags (`clioFeatureFlags`, all default OFF)

Constants: `AGENTIC_FLAGS` in `apps/api-strategy/src/flags/strategy-flags.service.ts`.
Each is enforced by a Nest guard on its routes AND re-checked fail-closed
in-service on the guard-less scheduler path (defense-in-depth).

| Short key | Dotted flag | Gates | Blast radius when ON (for that tenant, env-permitting) |
|---|---|---|---|
| `agenticMeri` | `agenticMeri.enabled` | Umbrella opt-in — `AgenticGuard` on the entire `/strategy-api/agents/*` surface (missions, runs, change-sets, execution). | Exposes the agent runtime to the tenant. Nothing runs automatically without a mission + trigger; sub-surfaces still need their own flag. |
| `contextSteward` | `contextSteward.enabled` | Steward extraction route (`/steward/documents/:id/extract`) + fact/conflict review. | Enables structured extraction of context docs into `sp_context_fact` / `sp_context_conflict`; feeds draft-gate health and Execution eligibility. Never mutates strategy nodes. |
| `strategyWatcher` | `strategyWatcher.enabled` | `StrategyWatcherGuard` on `run-check`; per-mission gate in the scheduler. | Enables watch-mode checks (manual and, with the scheduler env on, automated). Suggest-only: produces read-only proposed ChangeSets. |
| `executionAgentWorkspace` | `executionAgentWorkspace.enabled` | `ExecutionAgentGuard` on Workspace execution (`workspace` kind). | Lets the Execution Agent STAGE Workspace draft shells for eligible action/deliverable/submission nodes. No send; requires interactive bearer. |
| `executionAgentOutreach` | `executionAgentOutreach.enabled` | `ExecutionAgentGuard` on outreach execution (`outreach` kind). | Lets the Execution Agent STAGE outreach records for member/committee/agency nodes + mint (never satisfy) send-approval tokens. External send stays disabled. |
| `agentAutoApplyLowRisk` | `agentAutoApplyLowRisk.enabled` | Auto-apply of `low`-risk ChangeSets (RiskRouter `autoApplyEligible`). | Low-risk, non-firm proposals with ≥1 op auto-apply with an Undo. Firm-level and any medium+/critical proposal are never auto-applied regardless. Gate behind the Stage-B eval scorecard. |

Module-level context flags (Phase 1, not agentic): `strategyPlanner.enabled`
(`StrategyPlannerGuard` — the tenant must be on the planner at all) and
`strategyPlannerMeri.enabled` (Phase-1 Meri draft/assistant). The agentic
guards stack **on top of** `StrategyPlannerGuard`.

---

## 3. Rollout funnel (plan §Stage H)

Each rung is a discrete, reversible move. Do not skip rungs. `capiro-internal`
is the dogfood tenant for rungs 1–3; design-partner ("pilot") firms begin at
rung 4. Every rung is Neo-gated: env/flag flip + authenticated eyeball + a
scoped diag-read row-count confirmation, the same close-out ritual as G7.

| # | Rung | What flips | What to watch | Gate to the next rung |
|---|---|---|---|---|
| 1 | **Internal Steward** | `STRATEGY_AGENTS_ENABLED=true` (env) + `agenticMeri.enabled` + `contextSteward.enabled` on `capiro-internal` | Extraction produces sane `sp_context_fact`/`sp_context_conflict` rows with citations; draft-gate health reflects missing/conflicted context; no cross-tenant leakage (diag-read scoped). | Steward facts/conflicts land correctly and health feeds the A8 draft banner. |
| 2 | **Internal Watcher (manual)** | `strategyWatcher.enabled` on `capiro-internal`. Scheduler env still OFF. | `Run check now` produces deterministic findings + read-only proposed ChangeSets; findings dedup on `(strategyId, code, nodeIds)` (re-run updates, never duplicates); a no-finding check creates no noise. | Manual checks are accurate and quiet-when-clean; ChangeSet review queue renders. |
| 3 | **Internal Watcher (scheduler ON)** | `STRATEGY_WATCHER_SCHEDULER=true` (env) — arms scheduler + outbox loops. | One-run-per-mission-per-day (day-bucketed idempotency key); plan edits bring missions forward within one drain; firm-calendar placeholder emits a critical finding only on a real calendar change; loops survive a poisoned mission (per-item try/catch); no runaway run creation. | Automated cadence + edit-triggered checks behave; run ledger clean; no duplicate runs across a redeploy. |
| 4 | **Pilot firms — suggest-only** | `agenticMeri` + `contextSteward` + `strategyWatcher` on the pilot tenant(s). Auto-apply and execution flags stay OFF. | Same signals as rungs 1–3 on a real client's data; cross-client isolation holds; runtime cost trends within the §6 pilot envelope. | Pilot suggest-only stable; **Stage-B eval scorecard exists** (L1 pass-rate 100%, one L2 run reviewed by Neo, thresholds recorded). |
| 5 | **Workspace execution (limited doc types)** | `executionAgentWorkspace.enabled` on the chosen tenant. | Eligibility gates hold (action + deliverable/submission subject, owner + target date, no open material conflict, workspace access); G0 pre-exec re-check parks on drift; idempotent artifact staging (no duplicate shells on retry); run stops before submission. **Blocked until the rung-4 scorecard gate passes.** | Workspace staging is idempotent + eligibility-correct on the limited doc types. |
| 6 | **Outreach staging** | `executionAgentOutreach.enabled`. | Do-not-contact / client-constraint validation blocks staging; send-approval token is minted against exact staged content and bound to the run; **no send occurs** (`SEND_DISABLED_REASON`); a content change invalidates a minted token. | Outreach staging + token machinery correct; send provably disabled. |
| 7 | **Auto-apply low-risk** | `agentAutoApplyLowRisk.enabled`. | Only `low`-risk, non-firm, ≥1-op ChangeSets auto-apply; every auto-apply carries an Undo (version restore); firm-level + medium/high/critical always route to the review queue. **Gated on the Stage-B scorecard** (F-auto-apply/G do not activate until it exists and thresholds are met). | Auto-apply behaves; Undo works; scorecard trending stable-or-up. |
| 8 | **External send** | **Separate security approval only.** No env/flag in this branch turns it on. | N/A — do not attempt. `STRATEGY_EXECUTION_SEND_ENABLED` stays unset. | A dedicated security sign-off (permission bypass + cross-client + send-invalidation suites) is the gate — out of scope for this rollout. |

---

## 4. Migration

**Stage-C additive migration:** `apps/api-strategy/prisma/migrations/20260724000000_agent_foundations/migration.sql`.
Creates the 9 `sp_*` enums (`sp_context_doc_state`, `sp_context_scope`,
`sp_fact_state`, `sp_conflict_state`, `sp_mission_state`, `sp_run_state`,
`sp_run_trigger`, `sp_change_set_status`, `sp_change_set_risk`), the 8 tables,
their indexes (incl. the unique `(tenant_id, idempotency_key)` on `sp_agent_run`
and `(tenant_id, key)` on `sp_agent_permission_policy`), the two intra-schema
FKs (`sp_context_fact → sp_context_document`, `sp_agent_run → sp_agent_mission`,
both `ON DELETE CASCADE`), and RLS `ENABLE`/`FORCE` + `_isolation` policies
`USING (rls_bypass() OR tenant_id = current_tenant_id())` on all 8 tables. Fully
additive — no pre-existing table is altered.

**Run it via the established one-off migrate task** (same path as the
G1/G3/G5/G7 migrations — see `api-strategy-g1-deploy.md` Step 2), using the
**master** DB credential (DDL + RLS grants):

```
aws ecs register-task-definition --cli-input-json file://infra/deploy/api-strategy-migrate-taskdef.json --profile capiro-dev
aws ecs run-task --cluster capiro-dev --launch-type FARGATE \
  --task-definition capiro-dev-api-strategy-migrate \
  --network-configuration "awsvpcConfiguration={subnets=[<3 private subnets>],securityGroups=[<service SG>],assignPublicIp=DISABLED}" \
  --profile capiro-dev
aws logs tail /capiro/dev/api --log-stream-name-prefix api-strategy-migrate --follow --profile capiro-dev
```

Expect `prisma migrate deploy` to apply `20260724000000_agent_foundations`
(after the already-live migrations below). **Verify (read-only)** via the
`capiro-dev-api-diag` scoped diag pattern: the 8 `sp_*` tables + 9 enums exist,
and each table shows its `_isolation` RLS policy (`\d+`).

**Rollback SQL** (from the migration header — additive, no data loss for
pre-existing tables; reverse order):

```sql
DROP TABLE IF EXISTS "sp_event_outbox", "sp_agent_permission_policy",
  "sp_change_set", "sp_agent_run", "sp_agent_mission",
  "sp_context_conflict", "sp_context_fact", "sp_context_document" CASCADE;
DROP TYPE IF EXISTS "sp_change_set_risk", "sp_change_set_status",
  "sp_run_trigger", "sp_run_state", "sp_mission_state",
  "sp_conflict_state", "sp_fact_state", "sp_context_scope",
  "sp_context_doc_state";
```

In practice a data rollback is unnecessary: the tables are unreferenced by any
other service and can be left in place (mirrors the G1 rollback note). Prefer
the flag/env rollback (§5) over dropping tables.

**Two Stage-A migrations already live** (node-level additions, applied ahead of
this one): `20260723000003_sp_node_depends_on` (adds
`sp_node.depends_on_ids uuid[] NOT NULL DEFAULT '{}'`) and
`20260723000004_sp_node_provenance` (adds `sp_node.provenance jsonb`). Both are
additive with drop-column rollbacks.

---

## 5. Rollback

Rollback is layered, from surgical to total — and every layer is a flag/env
flip, never a code deploy:

- **Per-rung rollback = that rung's flag OFF.** Turn off any per-tenant
  `clioFeatureFlags` key (or `STRATEGY_VERIFY_BLOCK` for the Stage-A gate) to
  retract exactly that surface for that tenant; the 60s `StrategyFlagsService`
  cache means the change takes effect within ~1 minute, no restart.
- **Stop the background loops** = unset `STRATEGY_WATCHER_SCHEDULER` (taskdef
  env) and roll. On the next task start the `setInterval` timers are never
  armed (`onModuleInit` returns early); no scheduler tick, no outbox drain. In
  the meantime the loops are re-entrancy-guarded and per-item isolated, so they
  cannot wedge.
- **Master rollback = `STRATEGY_AGENTS_ENABLED=false`** (or unset) — one taskdef
  env flip + roll (~60s to steady state). Because the env is ANDed into
  `isAgenticFlagEnabled` (short-circuits before any DB read) AND is a hard
  precondition of both background loops, this disables **every** agentic
  surface for **every** tenant at once, regardless of per-tenant flags. This is
  the admin kill switch. (Verify once, live, that with it off: `/agents/*`
  routes 403, the scheduler logs no "armed" line, and no new `sp_agent_run`
  rows appear.)
- **Data:** never required for rollback. If a full teardown is ever wanted, use
  the §4 rollback SQL; otherwise leave the additive tables in place.

---

## 6. Retention / deletion

All Phase-2 rows are **tenant-scoped** — every `sp_*` table carries a
`tenant_id UUID NOT NULL` column with an RLS isolation policy (verified in
`20260724000000_agent_foundations`), and `sp_node.depends_on_ids` /
`sp_node.provenance` live on the already-tenant-scoped `sp_node`.

- **Tenant-deletion checklist — ACTION REQUIRED.** The current tenant hard-delete
  (`apps/api/src/internal-onboarding/internal-onboarding.service.ts`
  `hardDeleteExpiredTenant`) does `tx.tenant.delete()` and relies on FK cascade
  **within the apps/api Prisma schema**. The `sp_*` tables live in the
  **api-strategy** schema and have **no cross-schema FK to `tenants`** (the
  cross-schema-FK prohibition holds), so they are **NOT** swept automatically by
  that cascade. Because they all carry `tenant_id`, a scoped `DELETE … WHERE
  tenant_id = <id>` on the `capiro` DB covers them cleanly — but this must be
  **explicitly added to the tenant-deletion checklist**. The delete order that
  respects the intra-schema FKs (and the append-only `sp_activity_log` trigger,
  which must be bypassed with master/`rls_bypass`): purge child rows before
  parents — `sp_context_fact`/`sp_context_conflict` before
  `sp_context_document`; `sp_agent_run`/`sp_change_set` before
  `sp_agent_mission`; then `sp_agent_permission_policy`, `sp_event_outbox`, and
  the `sp_strategy`/`sp_node`/`sp_version`/`sp_activity_log` core.
- **Outbox pruning.** `sp_event_outbox` rows are consumable and prunable: once
  `consumed_at IS NOT NULL` they are never reprocessed (the drain filters on
  `consumed_at IS NULL`). A periodic `DELETE FROM sp_event_outbox WHERE
  consumed_at < now() - interval '30 days'` is safe housekeeping (no consumer
  ever re-reads a consumed row). Unconsumed rows must be left alone.
- **Run findings.** `sp_agent_run.findings` (JSON) may hold plan snapshots /
  proposed-op detail and calendar fingerprints. This is **no external PII beyond
  what the strategy already holds** — it references the tenant's own nodes,
  dates, and reference calendars. No message bodies or recipient PII are stored
  by any staged-only execution run (external send is disabled). Findings are
  purged with their `sp_agent_run` row on tenant deletion.

---

## 7. Observability

**What exists today:**

- **Append-only audit trail.** Every mission/run/change-set/node mutation is
  logged through `VersioningService.logActivity` into `sp_activity_log`
  (append-only trigger), attributed with `authorKind` (`person` for a user,
  `meri` for scheduler/system work), `entityType`/`entityId`
  (`run`/`changeset`/`node`/…), and before/after payloads. The same call emits
  the `sp_event_outbox` row in the same tx. This is the authoritative "who did
  what" record and is queryable per tenant via diag-read.
- **Run findings JSON.** `sp_agent_run.findings` accumulates structured state:
  `findings[]` (each `{code, severity, message, nodeIds}`),
  `riskClassification` (from the pure `RiskRouter`), `calendarFingerprint`
  (firm-calendar placeholder), `execution` meta (kind, nodeId,
  pinnedVersionId), and — Stage H, now built — `metrics`
  (`{lastPhase, model?, promptSpecVersion?, latencyMs?}`), stamped additively on
  every phase exit by the pure `stampRunMetrics` (`agents/run-metrics.ts`) via
  `ExecutionService.settlePhase`/`stampMetrics` and
  `WatcherService.stampMetrics`. Only `lastPhase` is guaranteed; `model` /
  `promptSpecVersion` / `latencyMs` are written only when the phase carries them
  (a later phase merges onto the prior metrics, never replacing), and the stamp
  is best-effort (an observability write never fails a run). No token count is
  recorded here — real per-run token $ cost remains the `ai_usage.agent_run_id`
  cross-app seam (below). Runs are keyed by id and by
  `(tenantId, idempotencyKey)`.
- **AI usage metering.** The orchestrator meters every LLM round via
  `recordAiUsageEvent` (`@capiro/shared`) into `ai_usage_events` with
  `tenantId`, `userId`, `workflow` (`meriv2_strategy_draft` /
  `meriv2_strategy_edit` / `meriv2_steward_extract`), `model`, token counts,
  and `costUsd` — billed to tenant keys. This is the live cost/latency-adjacent
  signal available now.
- **Structured log lines.** Each agent service uses a Nest `Logger(ServiceName)`;
  the scheduler/outbox/execution log lines already interpolate mission id, run
  id, tenant id, and strategy id inline (e.g. the scheduler's
  `mission ${id}, tenant ${id}` failure log), so runs are traceable in
  CloudWatch by id today.
- **Per-tenant concurrent-run cap (load-shed valve).** `RunsService.createRun`
  enforces `STRATEGY_AGENTS_MAX_CONCURRENT_RUNS` (default **20**, floored at 1 —
  see §2.1): before minting a genuinely-new run it counts the tenant's runs in
  `CONCURRENT_RUN_STATES` (`queued`/`planning`/`waiting_for_input`/`executing`)
  and throws a **503** (`"too many active agent runs for this tenant"`) at/over
  the cap. `ready_for_review` + terminal runs do not count; idempotent replays
  bypass the check. It is a **soft** cap (count + insert are not atomic). A burst
  of these 503s in the api-strategy log — most plausibly the scheduler claiming a
  batch of due missions — is this valve shedding load, **not** an outage: raise
  the env to widen the ceiling.

**Stage-H seams (documented, NOT yet built — do not assume live):**

- **`ai_usage.agent_run_id`** — `AiUsageContext` currently carries only
  `tenantId`/`userId`. Threading the originating `sp_agent_run.id` onto the
  metering context is the seam that lets cost/latency be attributed per run;
  the column/field does not exist yet.
- **Uniform per-run logger context** — binding a child logger stamped with the
  run/mission/change-set id (rather than ad-hoc string interpolation) is the
  Stage-H structured-logging cleanup.

**DoD verification pointers (per plan §5, per stage):**

- **Stage A:** a violation-inviting goal repairs in-loop (`plan.verified`
  activity row, 0 errors) or returns an unsaved proposal; strict tool use on
  `claude-sonnet-5` (zero invalid-tool 400s over 20 drafts); partial-context
  draft shows the amber banner + `groundingHealth` activity row.
- **Stage B:** `eval:l1` green in CI over ≥12 goldens; one reviewed L2 scorecard
  with recorded thresholds (the gate for rungs 5/7).
- **Stage C:** run lifecycle drivable with zero LLM (state-machine specs);
  idempotent replay creates no duplicate run; every write attributed; flags keep
  everything hidden.
- **Stage F:** no-change checks create no noise; stale ChangeSets (pinned
  `strategy_version_id != head`) are unapprovable; auto-apply off by default.
- **Stage G:** idempotent artifact staging; cited drafts; no self-submission; a
  mid-mission plan change parks the run for re-approval (G0); a content change
  invalidates a minted send token (G2).
- **Program (Phase-2 exit):** flags on for `capiro-internal` only; external send
  disabled; scorecard stable-or-up across 4 weekly L2 runs; every rung's
  rollback (its flag off + the master kill switch) verified once live.

---

## Notes / guardrails

- `capiro-dev` IS real prod. Env flips ride the taskdef roll; per-tenant flags
  ride the diag run-task override — never edit the change-controlled
  auth/Clerk/Graph-OAuth files.
- Activation order is non-negotiable: env master switch → per-tenant flags →
  (later) scheduler env. A tenant flag with the master env off does nothing
  (fail-closed), and the scheduler with the master env off never arms.
- Do not set `STRATEGY_EXECUTION_SEND_ENABLED`. External send is out of scope
  until a separate security sign-off; it is documented only as a seam.
