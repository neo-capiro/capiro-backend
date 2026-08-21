# Phase 8 Session 10 — Closeout Handoff

**Prepared:** 2026-08-21
**Repository:** `neo-capiro/capirov2`
**Authoritative `main` at session start:** `7b4e26765da91249a24d64c2dc119d4014bc8b4e` (PR #1165, Session 9 — verified against live GitHub, not assumed)
**Session 10 branch:** `agent/phase8-session10-schedule-control-plane`
**Workstream:** production schedule ownership over the Session 7/8 control loop

---

## 1. Final verdict

```text
SESSION10_COMPLETE
READY_TO_MERGE_SESSION10   (awaiting separate explicit authorisation)
```

Dark: no HTTP route, no active `@Cron`/`ScheduleModule`/EventBridge
registration, no AWS mutation, no production database or schedule mutation,
no snapshot promotion, no GPU.

## 2. Scope derivation — read this first

**There is no Session 10 specification document in this repository**, the
same absence Sessions 8 and 9 each found and stated plainly. Scope came from
seven code and documentation sites that agree exactly:

| Location | States |
|---|---|
| `scripts/verify-phase8-session7.mjs:464` | "production schedule ownership is Session 10" (the confirmed forward-pointer named in the Session 8 handoff's own scope table) |
| `budget-lifecycle.module.ts` (doc comment) | "no EventBridge watcher is enabled: production schedule ownership is Session 10's work" |
| `run-lifecycle-watcher.mjs` (doc comment) | "schedule ownership is Session 10's work" |
| `run-live-discovery.mjs` (doc comment) | "production schedule ownership is Session 10's work" |
| `docs/runbooks/defense-cross-domain-providers-v1.md`, §8 | "Production schedule ownership is Session 10's" |
| `scripts/verify-phase8-session9.mjs` (×2 prohibition checks) | "production schedule ownership is Session 10" |
| `docs/defense-budget/phase8-session9-provider-handoff.md`, §12 | "Schedule ownership remains Session 10's. Session 9 registers none." |

That map was re-confirmed against the live repository before any code was
written (§`docs/defense-budget/phase8-session10-schedule-design.md`, §1),
not assumed from memory of a prior session.

## 3. Files changed

21 files.

```text
apps/api/prisma/migrations/20261211120000_phase8_session10_schedule_control_plane/migration.sql
apps/api/prisma/schema.prisma                                    (1 model)
apps/defense-api/package.json                                    (1 convenience script)
apps/defense-api/scripts/run-schedule-controller.mjs
apps/defense-api/src/budget-lifecycle/budget-lifecycle.module.ts (new providers registered)
apps/defense-api/src/budget-lifecycle/schedule/
    schedule-audit.port.ts          prisma-schedule-audit.store.ts
    schedule-coordinator.service.ts schedule-coordinator.spec.ts
    testing/schedule-test-doubles.ts
docs/defense-budget/phase8-session10-schedule-{design,handoff}.md
docs/runbooks/defense-schedule-control-plane-v1.md
package.json                                                      (4 scripts)
packages/defense-domain/src/budget-lifecycle/{schedule.ts,index.ts}
scripts/{verify,test}-phase8-session10-*
.github/workflows/phase8-session10-schedule-control-plane.yml
```

**Deliberately NOT changed**, and proven so — not merely claimed: every file
under `apps/defense-api/src/budget-lifecycle/` except
`budget-lifecycle.module.ts` and the new `schedule/` directory is
byte-identical to `origin/main`. `scripts/verify-phase8-session10.mjs`
asserts this directly via `git diff --name-only origin/main --
apps/defense-api/src/budget-lifecycle` and fails if anything else differs.
In particular: `lifecycle-ports.ts` (the `LifecycleStore` interface),
`prisma-lifecycle.store.ts`, `testing/in-memory-lifecycle.store.ts`,
`lifecycle-watcher.service.ts`, `annual-cycle-controller.service.ts`,
`source-adapter.registry.ts`, and everything under `discovery/` are
untouched. The due-state read this session needs goes through a new,
separate `ScheduleAuditStore` port instead — the same precedent Session 9
set with `DiscoveryAuditStore` rather than widening `LifecycleStore` for its
own needs.

## 4. Acceptance criteria

| Criterion | Status |
|---|---|
| Scheduler/control-plane implementation | `ScheduleCoordinatorService.tick()` — orchestrates all 14 registered adapters per invocation |
| Deterministic schedule ownership | `evaluateAdapterDue(adapterId, nextCheckAt, nowIso)` — pure, no hidden clock reads, asserted by the static gate |
| Lease/locking/concurrency semantics | Reused verbatim from Session 7's `acquireAdapterLease` (one atomic statement); the coordinator adds no locking of its own |
| Idempotent triggering | Sequential re-delivery: due-check sees the advanced `next_check_at` and skips (proven in spec). Concurrent re-delivery: Session 7's atomic lease. Beneath both: Session 7's `UNIQUE` constraints on observations/outbox |
| Missed-run/catch-up behaviour, bounded | One `runAdapter` call per due adapter per tick regardless of how overdue; `nextWatcherCheckAt` re-anchors to `nowIso`, not to the stale value (proven in spec with a next_check_at set months in the past) |
| Retry/backoff | Reused verbatim from Session 7's `nextWatcherCheckAt` (seasonal + exponential, deterministic, no jitter) |
| Failure isolation | New: per-adapter try/catch around `runAdapter`; one adapter throwing does not stop the loop (proven in spec across three adapters, two different authority tracks) |
| Per-FY/per-authority-track independence | Inherited unchanged from Session 7's `UNIQUE (fiscal_year, authority_track)`; the scheduler contains no fiscal-year concept to interact with it (asserted by the static gate) |
| Health/staleness visibility | New `defense_budget_schedule_tick` table — one row per tick, when nothing before this session recorded that a tick was even attempted |
| Audit trail | Same table, append-only by grant (no DELETE to either role) |
| Migrations | 1 table, 10 CHECK constraints, 3 indexes, least-privilege grants |
| Configuration | `PHASE8_SESSION10_TICK_AUTHORIZED` gates the one write path; `PHASE8_SESSION8_LIVE_DISCOVERY` (Session 8's own variable, unchanged) still gates live vs. manifest discovery |
| Test doubles | `InMemoryScheduleAuditStore`, `ThrowingScheduleAuditStore` |
| Focused tests | Domain (18) + coordinator spec (8) |
| Disposable-Postgres rehearsal | 39 checks, real zero-state PostgreSQL, full 311-migration ledger |
| Replay/concurrency tests | See engineering-invariant proofs, §5 |
| Static verifier | `verify-phase8-session10.mjs` |
| CI workflow | `.github/workflows/phase8-session10-schedule-control-plane.yml` |
| Operator runbook | `docs/runbooks/defense-schedule-control-plane-v1.md` |
| Session 10 handoff | This document |

## 5. Engineering-invariant proofs (the acceptance checklist's own list)

| Invariant | Where proven | Result |
|---|---|---|
| Two overlapping FY tracks execute independently | Inherited from Session 7's DB constraint; scheduler is FY-blind by construction | Structural, asserted by static gate (no FY literal in `schedule.ts`) |
| One failed source/track does not block unrelated tracks | `schedule-coordinator.spec.ts`, "isolates a throwing adapter..." across `hasc`/`sasc`/`congress-gov` (authorization + appropriations) | PASS |
| Duplicate scheduler delivery cannot duplicate lifecycle work | `schedule-coordinator.spec.ts`, "a second tick... does not re-run", plus Session 7's own `UNIQUE` constraints underneath | PASS |
| Two workers racing for the same due work cannot both own it | Session 7's atomic `acquireAdapterLease`, exercised via `schedule-coordinator.spec.ts` "isolates a held lease..." | PASS |
| Stale leases recover deterministically | Inherited: `acquireAdapterLease`'s `WHERE lease_expires_at <= now` clause; unchanged, not re-tested at the coordinator level beyond confirming the coordinator does not interfere | Structural |
| Catch-up after downtime is bounded | `schedule-coordinator.spec.ts`, "an adapter overdue by months still runs at most once per tick" | PASS |
| Unchanged source bytes still produce no downstream duplicate work | Inherited: Session 7's content-SHA idempotency; the scheduler adds no new content path | Structural, exercised in DB rehearsal indirectly via `defense_budget_watcher_run`/`watcher_adapter` presence checks |
| Provider runtime stays dark unless explicitly activated | Untouched by this session; `defense-api` typecheck/build re-verified green | PASS |
| No hidden "current year" assumption | `schedule.ts` contains no `getFullYear`/`CURRENT_FISCAL_YEAR`/fiscal-year literal, asserted by the static gate; domain test "due-ness contains no fiscal-year or calendar-year concept at all" runs the same decision across three different years | PASS |

## 6. Database rehearsal

`SESSION10_DB_REHEARSAL_PASS (39 checks)` from a zero-state PostgreSQL 16,
the full 311-migration ledger (280 pre-existing + Sessions 2/3/6/7/8/9/10)
applied from scratch — not a scoped subset.

Negative controls: outcome outside its enum; `outcome='failed'` with no
`failure_reason`; `outcome='completed'` *with* one (coherence checked in
both directions); `finished_at` preceding `started_at`; a blank `worker_id`
or `tick_key`; `adapters_due` exceeding `adapters_considered`; the
succeeded/failed/skipped-lease partition not summing to `adapters_due`; a
negative adapter count; a `failure_reason` over 500 characters.

Positive control and idempotency: a coherent row is accepted; the identical
`(worker_id, tick_key)` written again with a different outcome replaces the
row rather than duplicating it (measured: exactly one row, with the second
write's values).

**Role boundary, measured, not assumed:**

```text
capiro_defense_serve:  SELECT only on defense_budget_schedule_tick
capiro_defense_job:    SELECT, INSERT, UPDATE — NOT DELETE
```

Both proven by actually connecting as rehearsal logins that inherit the real
NOLOGIN capability roles and attempting the forbidden operation. Additionally
measured, not assumed: `capiro_defense_job` can now `SELECT next_check_at`
from `defense_budget_watcher_adapter` (the actual point of this session), and
Session 7's own no-DELETE boundary on `defense_budget_watcher_run` is
unchanged by this session's grants.

Zero monetary-shaped and zero secret-shaped columns on the new table,
measured against `information_schema.columns`, not trusted from the
migration's own comments.

## 7. Regression results — all fresh on this exact candidate

```text
S2  SESSION2_BOUNDARY_PASS
S3  SESSION3_BOUNDARY_PASS
S3  SESSION3_ADMIN_BOUNDARY_PASS
S4  SESSION4_SOURCE_PARITY_PASS (--enforce-replay)
S4  SESSION4_IMAGE_CONTAINMENT_PASS (8 checks)
S4  PHASE7_TYPECHECK_BASELINE_MATCH
S5  full negative-provider-decision suite green (70+ individual checks);
    NVIDIA_NOT_ADOPTED / DETERMINISTIC_PRIMARY intact
S6  SESSION6_FEDERAL_FUNDING_FOUNDATION_PASS + domain 9/9
S7  SESSION7_LIFECYCLE_CONTROL_PLANE_PASS + domain 57/57 + control loop 32/32
S8  SESSION8_LIVE_DISCOVERY_PASS
    + discovery domain 40/40 + publisher-native domain 15/15 + control loop 15/15
S9  SESSION9_PROVIDER_RUNTIME_PASS + domain 36/36 + runtime spec 30/30
S10 SESSION10_SCHEDULE_CONTROL_PLANE_PASS
    + domain 18/18 + coordinator spec 8/8 + DB rehearsal 39/39
defense-api: full spec suite 143 run, 135 pass, 0 fail, 8 skipped (pre-existing,
    unrelated to this session — network/DB-dependent specs already skipped on main)
defense-api: typecheck PASS; build PASS
apps/api: typecheck exits 2 with EXACTLY 16 errors, category-for-category
    identical to the Session 9-documented baseline (4 rootDir + 1
    intelligence/alert-memo + 2 memory + 6 meri + 3 reviews = 16). This
    session touches no apps/api TypeScript source, so this is the same
    pre-existing baseline re-measured, not re-derived from a stash.
Prisma: apps/api validate PASS + generate PASS; defense-api validate PASS
Frozen budget-lifecycle/ surface: only budget-lifecycle.module.ts and
    schedule/** differ from origin/main (asserted by the static gate)
git diff --check: clean
```

GitHub Actions remains externally unavailable repo-wide (startup failures
since 2026-07-31, reconfirmed live at session start on this exact PR's own
initial pushes). The Session 10 workflow is added; every gate above was run
locally on this exact candidate.

## 8. Safety statement

```text
AWS mutated:                     NO
Production DB mutated:           NO
Production schedules changed:    NO   (no @Cron/ScheduleModule/EventBridge anywhere)
Production routes changed:       NO   (defense-api still exactly 49)
Snapshot promoted or activated:  NO
NVIDIA provisioned or restarted: NO   (Session 5 remains NVIDIA_NOT_ADOPTED)
Live provider call made:         NO
Provider / AWS spend:            $0
Session 11 started:              NO
Session 10 PR merged:            NO
```

Nothing in this session installs a trigger. `ScheduleCoordinatorService` is a
constructible NestJS provider; by itself, registering it in
`budget-lifecycle.module.ts` schedules nothing. The one path that mutates a
real database — `run-schedule-controller.mjs --tick --commit` — additionally
requires `PHASE8_SESSION10_TICK_AUTHORIZED=true`, was never set in any
environment this session touched, and was exercised only against the
disposable rehearsal database above and the fully in-memory coordinator spec.

## 9. Disclosed limitations

### 9.1 The schedulable unit is the adapter, not (fiscalYear, authorityTrack)

Each of the 14 adapters is bound by the governed cycle template to one
authority track, but not to one fiscal year — a single adapter's crawl can
surface documents for several fiscal years in one run, exactly as Session 8
built it. "Per-(fiscalYear, authorityTrack) independence" is therefore
proven at the level Session 7 already guarantees it (the DB's own
`UNIQUE (fiscal_year, authority_track)`), not by the scheduler partitioning
work along that axis — the scheduler was never given fiscal-year information
to partition by, deliberately, per §5.3 of the design doc.

### 9.2 No live tick has ever run

Every proof above is a disposable-database rehearsal or an in-memory spec.
`run-schedule-controller.mjs --tick --commit` was never invoked against a
real deployed database, because no deployed database exists for this
session to reach — activation is explicitly out of scope. The first real
tick's actual timing/throughput characteristics are therefore unverified
until that deployment act happens; the runbook (§6) states what to check
then.

### 9.3 `apps/api` full typecheck has 16 pre-existing errors

Unchanged from the Session 9-documented baseline, confirmed category-for-
category identical (§7). Out of Session 10 scope; this session's own file
changed there is `schema.prisma`, which introduces zero new errors.

### 9.4 No egress allowlisting performed

Unchanged from Session 8: the four Akamai-protected publisher hosts still
refuse a plain client. This session's scheduler will simply record those
adapters as `ran_failed` (or the discovery layer's own `blocked_by_publisher`
status, one level deeper) until that deployment-side allowlisting happens;
nothing about scheduling changes that fact.

### 9.5 `MAP_STYLE_ATTRIBUTION`

Still needs its real value restored — carried forward from the Engagement
vNext session, unrelated to Phase 8, noted again for continuity.

## 10. Open items for Session 11+

1. **Activation** — wiring an actual trigger (EventBridge rule, ECS scheduled
   task) to invoke `run-schedule-controller.mjs --tick --commit` on a real
   cadence, plus the egress allowlisting from Session 8's own open items, is
   deployment work this session deliberately did not do.
2. **Product/HTTP integration** — `CycleHealthService` (Session 7) still has
   no route; a tick-health view analogous to it (reading
   `defense_budget_schedule_tick`) is unbuilt. Still Session 11's territory,
   per the original forward-pointer map (`cycle-health.service.ts:5` →
   "product/HTTP integration, review-resolution UI").
3. **`defense_budget_schedule_tick` is intentionally absent from the curated
   `defense-api` HTTP Prisma subset** (same precedent as Sessions 6-9); the
   store uses parameterised raw SQL.

## 11. Commands

```bash
node scripts/test-phase8-session10-schedule-domain.mjs
pnpm --filter @capiro/defense-api exec tsx --test \
  src/budget-lifecycle/schedule/schedule-coordinator.spec.ts
node scripts/verify-phase8-session10.mjs
node scripts/verify-phase8-session10-db.mjs
```

**Do not merge until separately authorised.**
