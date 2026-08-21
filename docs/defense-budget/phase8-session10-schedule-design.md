# Phase 8 Session 10 — Production Schedule Ownership

**Workstream: schedule control-plane. Dark by default.**

Sessions 7, 8 and 9 each said the same thing on their way out, in three
different files:

> "This command deliberately does NOT install an EventBridge schedule, take
> production schedule ownership... schedule ownership is Session 10's work."
> — `run-lifecycle-watcher.mjs`

> "The command takes no schedule (production schedule ownership is Session
> 10's work)."
> — `run-live-discovery.mjs`

> "**Schedule ownership remains Session 10's.** Session 9 registers none."
> — Session 9 closeout handoff, §12

And the confirmed forward-pointer map recorded in the Session 8 handoff:

| Label | Location | Scope |
|---|---|---|
| Session 10 | `verify-phase8-session7.mjs:464` | production schedule ownership |

Session 10 is that. It adds no HTTP route, no active `@Cron`/`ScheduleModule`/
EventBridge registration, no snapshot promotion, and no GPU.

---

## 1. Scope derivation — read this first

**There is no Session 10 specification document in this repository**, the
same as Sessions 8 and 9 before it. Scope comes from seven code and doc sites
that agree exactly on what "production schedule ownership" means and, just as
importantly, on what it does *not* yet mean:

- `scripts/verify-phase8-session7.mjs:464`
- `apps/defense-api/src/budget-lifecycle/budget-lifecycle.module.ts` (doc comment)
- `apps/defense-api/scripts/run-lifecycle-watcher.mjs` (doc comment)
- `apps/defense-api/scripts/run-live-discovery.mjs` (doc comment)
- `docs/runbooks/defense-cross-domain-providers-v1.md`, §8
- `scripts/verify-phase8-session9.mjs` (two prohibition checks)
- `docs/defense-budget/phase8-session9-provider-handoff.md`, §12

None of these define an acceptance checklist — Sessions 8 and 9 hit the same
absence and derived their own from what the code already proved. This
session's acceptance criteria (§9 of the handoff) are derived the same way,
plus the engineering invariants any safe multi-adapter scheduler must satisfy
regardless of who specifies it.

## 2. What already existed, and what did not

Session 7 built every primitive a safe scheduler needs, and left it unused:

| Primitive | Where | Used by anything before this session? |
|---|---|---|
| Single-owner adapter lease, one atomic statement | `PrismaLifecycleStore.acquireAdapterLease` | Yes — inside `runAdapter`, guarding concurrent CLI invocations |
| Seasonal + exponential-backoff `next_check_at` | `nextWatcherCheckAt` | Computed and persisted by `runAdapter`, but nothing ever **read** it back to decide when to run |
| Per-collection resumable discovery cursor | `packages/defense-domain/.../discovery/crawl-cursor.ts` | Yes, inside a single `discover()` call |
| Per-host request pacing | `defense_budget_discovery_host_budget` | Yes, inside `LiveSourceDiscoveryAdapter` |
| Content-SHA idempotency (no duplicate work on unchanged bytes) | `defense_budget_source_observation` unique index | Yes, unconditionally |
| A loop that walks more than one adapter per invocation | — | **No. Confirmed by inspection**: both governed CLIs take exactly one `--adapter <id>` and call `runAdapter` once. |
| A clock-driven decision of which adapters are due | — | **No.** `defense_budget_watcher_adapter.next_check_at` is indexed and has been since Session 7, unread by anything. |

So the actual net-new surface is narrow: **the orchestration loop, and the
isolation boundary around it.** Everything about making one adapter's run
safe — lease, backoff, cursor, idempotency — stays exactly where Session 7
and 8 put it.

## 3. Architecture

```
ScheduleCoordinatorService.tick({ nowIso, workerId, tickKey, commit }):
  1. ensureRollingHorizon(nowIso)         — idempotent, Session 7's own primitive
  2. for each of the 14 registered adapters (independently):
       due?  = evaluateAdapterDue(state.nextCheckAt, nowIso)
       if not due:      record skipped_not_due, continue
       try:
         result = watcher.runAdapter({ adapterId, nowIso, leaseOwner: workerId, commit })
         (lease acquire/release, backoff, cursor, idempotency: all Session 7's)
       catch:           record ran_failed, continue        <- the new isolation boundary
  3. write ONE append-only tick-summary row
```

`ScheduleCoordinatorService` (`apps/defense-api/src/budget-lifecycle/schedule/schedule-coordinator.service.ts`)
depends on nothing new from Session 7 except a **read** of
`next_check_at` — added through a separate `ScheduleAuditStore` port
rather than by widening the frozen `LifecycleStore` interface. See §5.

### 3.1 What "due" means, precisely

`evaluateAdapterDue` (`packages/defense-domain/src/budget-lifecycle/schedule.ts`)
is a pure function of `(adapterId, nowIso)` and one prior state field,
`nextCheckAt`:

- no prior state, or a null `nextCheckAt` → due (a cold start must be
  operable with no engineer pre-seeding a schedule, the same principle
  Session 7 applied to fiscal years);
- `nextCheckAt <= nowIso` → due, however overdue;
- otherwise → not due.

However overdue an adapter's `next_check_at` is, calling `evaluateAdapterDue`
still yields exactly one decision. Bounded catch-up is a property of the
coordinator calling `runAdapter` **at most once per due adapter per tick**
and `nextWatcherCheckAt` re-anchoring to `nowIso` (not to the stale
`next_check_at`) afterwards — both already true of Session 7's own code.
The domain function contains no fiscal-year, calendar-year, or "current
year" concept anywhere, asserted by the static gate.

### 3.2 Failure isolation — the actual new guarantee

`DefenseBudgetLifecycleWatcher.runAdapter` can throw: its GPU assertion, its
initial `loadAdapterState` call, and its terminal `recordWatcherRun`/
`releaseAdapterLease` calls all sit outside its own internal try/catch. Before
this session nothing called it in a loop, so nothing needed to isolate that.
The coordinator wraps every per-adapter `runAdapter` call in its own
try/catch: one adapter throwing is bucketed into the tick's `adaptersFailed`
count and the loop continues to the next adapter unconditionally. Proven in
`schedule-coordinator.spec.ts` by making `loadAdapterState` throw for exactly
one of three adapters and asserting the other two still run and succeed.

A failure loading the due-state itself (the read this session adds) is
handled the same way, one level up: the coordinator fails **open**, not
closed — every adapter is treated as due rather than the tick going silent.
A scheduler that cannot read its own state and therefore runs nothing forever
is indistinguishable from a scheduler nobody is operating; failing open at
least attempts real, lease-guarded, idempotent work.

### 3.3 What the tick-level outcome means

`outcome: 'failed'` on the tick summary is reserved for the tick machinery
itself (the rolling-horizon bootstrap threw, or due-state could not be read
at all) — never for an individual adapter's failure, which is bucketed into
`adaptersFailed` while the tick otherwise `completed`. One bad adapter must
not read as "the scheduler is down."

### 3.4 Per-(fiscalYear, authorityTrack) and per-adapter independence

The schedulable unit is the **adapter** (14 of them), each bound by the
governed cycle template to one authority track (e.g. `hasc` → authorization,
`house-appropriations` → appropriations). The coordinator's per-adapter
try/catch means a failure processing `hasc` (authorization) cannot block
`house-appropriations` (appropriations) in the same tick — proven directly
in the spec with adapters on different tracks. Fiscal-year independence is
inherited unchanged from Session 7's `UNIQUE (fiscal_year, authority_track)`
cycle identity: the scheduler never reasons about fiscal year at all, so it
cannot introduce a cross-year interaction that was not already possible (or
impossible) before this session.

## 4. Idempotent triggering

Two distinct mechanisms, at two distinct layers, cover "duplicate delivery
cannot duplicate work":

- **Sequential duplicate delivery** (the tick is invoked twice, one after the
  other, for what should be one logical event): the second invocation's
  due-check sees the `next_check_at` the first invocation already advanced,
  and skips. Proven in the spec: two ticks at the identical `nowIso`, the
  second sees `skipped_not_due`.
- **Concurrent duplicate delivery** (two workers tick at the same instant):
  Session 7's atomic `acquireAdapterLease` — one `INSERT ... ON CONFLICT ...
  WHERE lease_owner IS NULL OR lease_expires_at <= now` — lets exactly one
  worker proceed; the other's `runAdapter` call returns
  `skipped_not_leased`, which the coordinator records as
  `skipped_lease_lost` without treating it as a failure.
- **Beneath both**, even if a due-check and a lease were somehow bypassed and
  `runAdapter` ran twice for genuinely the same content: Session 7's
  `UNIQUE (expected_source_id, content_sha256)` on observations and
  `UNIQUE (observation_id, job_kind)` on the outbox mean the second run
  produces zero new rows. The scheduler adds efficiency (skip the redundant
  attempt entirely); it was never the only thing standing between duplicate
  delivery and duplicate data.

## 5. The one deliberate design choice: a new port, not a wider `LifecycleStore`

`LifecycleStore.loadAdapterState` — frozen since Session 7 — does not return
`next_check_at`; no caller before this session needed it. Two ways existed to
give the coordinator a due-state read:

1. Add a field to `loadAdapterState`'s return type (additive, non-breaking
   TypeScript-wise).
2. Add a separate, new port that reads the same table independently.

Session 9 set the precedent for (2) with `DiscoveryAuditStore` rather than
widening `LifecycleStore` for its own needs, and this session follows it:
`ScheduleAuditStore` (`schedule-audit.port.ts`) reads
`defense_budget_watcher_adapter.next_check_at`/`lease_owner`/
`lease_expires_at` through its own `PrismaScheduleAuditStore`, and separately
owns the new append-only tick-summary write. `LifecycleStore`, both its real
and in-memory implementations, `lifecycle-watcher.service.ts`,
`annual-cycle-controller.service.ts`, and `source-adapter.registry.ts` are
untouched — the static gate proves this with `git diff --name-only
origin/main -- apps/defense-api/src/budget-lifecycle` and fails if anything
outside `budget-lifecycle.module.ts` and the new `schedule/` directory
differs.

## 6. Health / staleness visibility

`defense_budget_schedule_tick` — new, one row per tick, append-only by grant
(job: SELECT/INSERT/UPDATE, no DELETE, matching the
`defense_budget_watcher_run` precedent rather than the stricter INSERT-only
shape of a low-level observation table) — is what makes "the scheduler has
not run in three days" and "the scheduler has been running and finding
nothing due" distinguishable from outside. It deliberately does **not**
duplicate `defense_budget_watcher_run`'s per-adapter detail; it is a
tick-level summary (adapters considered/due/succeeded/failed/skipped-lease),
the level of information that did not exist at all before this session.

## 7. What Session 10 does not do

No HTTP route (the Session 3 surface stays frozen at 49 routes). No
`@Cron`, `ScheduleModule`, or EventBridge registration anywhere —
`ScheduleCoordinatorService` is a constructible provider, not a
self-triggering one. No production AWS or database mutation: the one
governed command, `run-schedule-controller.mjs`, defaults to a real-database
**read-only** plan or a fully in-memory dry run, and its one write path
requires both `--commit` and `PHASE8_SESSION10_TICK_AUTHORIZED=true`. No
change to Session 5's `NVIDIA_NOT_ADOPTED` decision, no snapshot promotion,
and no change to what discovery or classification decide — only to whether,
and how safely, they get invoked more than once per process.

Deciding *how often* to invoke the governed command — an EventBridge rule, an
ECS scheduled task — is a deployment act, deliberately outside this session,
exactly as "implementation vs. activation" was kept separate in Sessions 7-9.

## 8. Commands

```bash
node scripts/test-phase8-session10-schedule-domain.mjs
pnpm --filter @capiro/defense-api exec tsx --test \
  src/budget-lifecycle/schedule/schedule-coordinator.spec.ts
node scripts/verify-phase8-session10.mjs
node scripts/verify-phase8-session10-db.mjs

# Governed command
cd apps/defense-api
node scripts/run-schedule-controller.mjs --list-adapters
node scripts/run-schedule-controller.mjs --plan
node scripts/run-schedule-controller.mjs --tick
PHASE8_SESSION10_TICK_AUTHORIZED=true \
  node scripts/run-schedule-controller.mjs --tick --commit
```
