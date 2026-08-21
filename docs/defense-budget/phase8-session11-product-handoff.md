# Phase 8 Session 11 — Closeout Handoff

**Prepared:** 2026-08-21
**Repository:** `neo-capiro/capirov2`
**Authoritative `main` at session start:** `d1416b023b949a60d68adc2961893c4eb0e80074` (PR #1168, Session 10 — verified against live GitHub, not assumed; re-verified unchanged immediately before this handoff was written)
**Session 11 branch:** `agent/phase8-session11-product-integration`
**Workstream:** read-only product/HTTP integration over the Session 7-10 discovery/watcher/schedule control plane, plus the one governed CLI command capable of resolving a `review_required` hold

---

## 1. Scope derivation — read this first

**There is no Session 11 specification document in this repository**, the
same absence every prior Phase 8 session found and stated plainly. Scope came
from repeated, mutually corroborating code and documentation sites:

| Location | States |
|---|---|
| `apps/defense-api/src/budget-lifecycle/cycle-health.service.ts:5` | "Session 7 registers no controller for this: the Session 3 public route surface stays frozen and product integration is Session 11's work." |
| `packages/defense-contracts/src/public/budget-lifecycle.ts:4-6` | "These are the shapes Session 11 product integration will read. Session 7 does NOT register an HTTP route for them." |
| `docs/defense-budget/phase8-session8-discovery-handoff.md:19` | Forward-pointer map: S8=live crawling, S9=provider, S10=schedule, **S11=product** (citing `cycle-health.service.ts:5`). |
| `docs/defense-budget/phase8-session10-schedule-handoff.md` §10 item 2 | "Product/HTTP integration — `CycleHealthService` (Session 7) still has no route; a tick-health view analogous to it (reading `defense_budget_schedule_tick`) is unbuilt. Still Session 11's territory... ('product/HTTP integration, review-resolution UI')." |

That map was re-confirmed against the live repository before any code was
written (fresh clone, exact SHA match, zero drift).

## 2. The architectural finding that shaped everything

The Session 7 migration (`20261120230000_phase8_session7_budget_cycle_lifecycle/migration.sql`
§7) grants `capiro_defense_serve` **SELECT only** on every budget-lifecycle
table, and `capiro_defense_job` is the only role with INSERT/UPDATE, with its
own comment: *"HTTP serve reads the cycle-health state. The job/ingestion
role is the only writer."* This is a **database-enforced design boundary**
(not yet mechanically live — the connection-role cutover is still deferred,
per Session 2's own closeout — but the grants exist and the intent is
explicit).

This resolved the one real design question in "product/HTTP integration,
review-resolution UI": the UI cannot itself resolve a review, because the
role the HTTP process will use cannot write to these tables. The
"review-resolution UI" is therefore a **read-only view with full provenance
context** (why an item is held, its source URL, content hash, confidence),
and resolution happens through a new governed CLI script running under
job-role credentials — the same posture as every prior session's one
write-capable command (`run-lifecycle-watcher.mjs`, `run-live-discovery.mjs`,
`run-schedule-controller.mjs`).

The second architectural finding: system (A) — the older PE-Budget-Phase-7
lineage (`apps/api/src/program-element/*`, `apps/defense-api/src/program-elements/*`,
already has its own canonical-promotion + review-queue + HTTP surface) — and
system (B) — the Session 7-10 discovery/watcher/schedule domain this session
extends — are **completely disconnected**. System (B)'s tables are never
referenced anywhere under `apps/api/src`; its ingestion outbox has a producer
and no consumer. Session 11 builds a NEW, separate read surface for system
(B); it does not touch system (A) at all.

## 3. What was built

### Domain (`packages/defense-domain`)
- `buildScheduleTickHealth` (additive export in `budget-lifecycle/schedule.ts`) —
  aggregates already-persisted `defense_budget_schedule_tick` rows into a
  health view (last tick, staleness, completed/failed counts, per-adapter
  totals). This exact gap was named in the Session 10 handoff as unbuilt.

### Contracts (`packages/defense-contracts`)
- `DefenseScheduleTickHealthDto`, `DefenseExpectedSourceListItemDto`,
  `DefenseExpectedSourceDetailDto`, `DefenseReviewQueueItemDto` — additive to
  `public/budget-lifecycle.ts`.
- `DEFENSE_BUDGET_LIFECYCLE_PRODUCT_ROUTES` — a **new, separate** route table
  in `public/budget-lifecycle-product-routes.ts`, using its own
  `defineProductRoute` helper (never the string `defineRoute(`) so the
  Session 3 static scanner (which parses only `public/index.ts` for
  `defineRoute(` calls) cannot confuse the two tables. `public/index.ts`
  itself is untouched.

### `apps/defense-api` — new sibling module, zero touches to Sessions 7-10's own tree
- `src/budget-lifecycle-product/` (new directory, **not** nested under
  `budget-lifecycle/`): `budget-lifecycle-read.port.ts` (new, read-only port),
  `prisma-budget-lifecycle-read.store.ts` (raw-SQL SELECT-only implementation,
  same casting convention as `PrismaLifecycleStore`), `budget-lifecycle-query.service.ts`
  (composes the read store with the existing `CycleHealthService` and the new
  `buildScheduleTickHealth`; derives lifecycle signals READ-TIME via the
  frozen `deriveLifecycleSignals`, never persisting one),
  `budget-lifecycle-read.controller.ts` (six GET routes, reusing the
  `TenantGuard → DefenseMemberResolverGuard → RolesGuard` chain verbatim from
  `program-elements/budget-lines.controller.ts`), `budget-lifecycle-product.module.ts`,
  a `testing/` in-memory read-store double.
- `scripts/run-review-resolution.mjs` — the one governed, job-role,
  `--commit`-gated command that can move an expected source out of
  `review_required`. Calls the frozen `LifecycleStore.setExpectedSourceState`
  (the exact method the watcher itself uses) and separately writes one
  `audit_logs` row. Refuses if the target item is no longer `review_required`
  (idempotent-retry safety in place of a cross-store transaction — see the
  script's own header for why).
- `app.module.ts` gains one new import and one new entry
  (`BudgetLifecycleProductModule`) — nothing else in this file changed.

### Frontend (`apps/web`)
- New module `vnext/pages/defense-budget-lifecycle/` (API client, route
  predicate, module router, two pages: cycle health/coverage and the
  read-only review queue) — a genuinely new module with no canonical
  counterpart, following the exact precedent Funding Opportunities set (zero
  `App.tsx` changes needed; `VNextRouter.tsx` gets one new import block and
  one new path-claim branch).
- Both pages are gated to the `capiro-internal` tenant in-page (same posture
  as Program Elements v2), with real loading/empty/error states
  (`CapiroSkeleton`/`CapiroEmptyState`/`CapiroErrorState`) and no fabricated
  numbers — every field rendered is exactly what the API returned.
- The review queue's "Resolve" affordance is present but disabled, with a
  tooltip pointing at the governed CLI command — chosen deliberately over
  either omitting it (would read as "nothing can be done") or wiring a fake
  working button (would contradict §2's database boundary).

### Verification artifacts
- `scripts/verify-phase8-session11.mjs` — static verifier: frozen 49 routes
  intact, Session 11's own route table separate and all-GET, no reference to
  `LIFECYCLE_STORE`/write methods from the new HTTP-reachable files, zero
  diff against `origin/main` under `apps/defense-api/src/budget-lifecycle`,
  no GPU/NVIDIA/promoter credential, the CLI is fail-closed and never
  auto-invoked with `--commit`.
- `scripts/test-phase8-session11-domain.mjs` — 10 tests for
  `buildScheduleTickHealth`.
- `apps/defense-api/src/budget-lifecycle-product/budget-lifecycle-query.service.spec.ts` —
  6 tests over an in-memory double.
- `scripts/verify-phase8-session11-db.sh` (+ `.mjs` wrapper) — disposable
  Postgres rehearsal: role-boundary proof (serve SELECT-only on every table
  this session touches, job unchanged), the REAL compiled query service
  against a seeded FY2027 scenario (`scripts/verify-phase8-session11-integration.mjs`),
  and the review-resolution CLI end-to-end (list → dry run → authorised
  commit → refused repeat).
- `.github/workflows/phase8-session11-product-integration.yml`.
- `docs/runbooks/defense-budget-lifecycle-product-v1.md`.

## 4. What was NOT built, and why

- **No migration, no schema.prisma change.** Every read is a SELECT over
  tables Sessions 7-10 already created; nothing new needed to be stored.
- **No signal persistence.** `defense_budget_lifecycle_signal` still has no
  writer — signals are computed read-time, per request, from stored
  observation history.
- **No HTTP mutation of any kind.** See §2.
- **No activation of anything** — no EventBridge, no cron, no live provider
  call, no AWS mutation, no production DB mutation, no NVIDIA
  provisioning/restart. Session 5's `NVIDIA_NOT_ADOPTED` decision is
  unmodified and unread by anything this session adds.

## 5. Disclosed limitation: the disposable-database rehearsal was not run

**Docker Desktop could not be started in this sandboxed session.** The
`docker` CLI is present, but the daemon is unreachable
(`npipe:////./pipe/dockerDesktopLinuxEngine`), the GUI process never spawns
under `Start-Process`, and the `docker-desktop` WSL2 distro is `Stopped` with
no backend init script reachable from a non-interactive shell. This is an
**environment limitation of this specific sandbox**, not a defect in the
rehearsal script or the code it exercises — a prior session's own memory
confirms Docker-backed Postgres rehearsals have run successfully against this
exact repo before.

Concretely, this means:
- `scripts/verify-phase8-session11-db.sh`/`.mjs` and
  `scripts/verify-phase8-session11-integration.mjs` are written, reviewed
  against the exact seeded-data arithmetic they assert, and structured
  identically to Session 10's own proven rehearsal — but **were not
  executed** in this session.
- The regression re-run of prior sessions' OWN disposable-DB rehearsals (S7
  DB, S8 DB 51/51, S9 DB 43/43, S10 DB 39/39) could **not** be repeated here
  for the same reason. Every other regression gate in §7 below (all static
  verifiers, all domain unit tests, all runtime specs, both `prisma
  validate`, `git diff --check`, the `apps/api` 16-error baseline) WAS
  actually executed and is reported honestly.
- Everything achievable without a live database — the read store's SQL
  (hand-verified against the exact migration column definitions), the query
  service's composition logic (unit-tested against an in-memory double, 6/6),
  the domain aggregator (10/10), the CLI's argument/authorization gating
  (exercised directly, all three refusal paths confirmed) — was verified.

This is reported as `SESSION11_NOT_READY` for that reason alone; see §8.

## 6. Product correctness — what the read model represents

Every acceptance item from the product-correctness checklist maps to a real,
existing field rather than an invented one:

| Requirement | Where it lives |
|---|---|
| Fiscal year | `DefenseCycleHealthDto.fiscalYear`, every list/detail item |
| Authority track | `authorityTrack` on every shape; 5 independent tracks, never collapsed |
| Source stage | `stage` (27 `LifecycleStage` values, frozen Session 7 enum) |
| Source/provenance | `discoveredUrl`, `contentSha256`, `sourceDocumentId` on `DefenseSourceObservationDto` |
| Current vs superseded | `supersededByObservationId` (forward pointer) / a new `supersedesDedupKey` reverse lookup added to the read port |
| Request/authorization/appropriations differences | `tracks: DefenseCycleTrackHealthDto[]`, keyed per track, never merged |
| CR/supplemental as overlays | `alternative_funding` is its own track with its own stages (`continuing_resolution`, `supplemental`, etc.) — never presented as replacing `authorization`/`appropriations` |
| Unresolved ambiguity/review state | `expectedState`/`observationState = 'review_required'`, `reviewReason`/`reviewReasons` |
| Canonical amount only when supported | `knownFundingPosition: null`, hard-typed, always — this domain asserts no dollars by construction |
| Source freshness/staleness | `lastDiscoveryAt`, `nextWatcherRunAt`, `staleAdapters` |
| Lifecycle status/readiness | `DefenseScheduleTickHealthDto` (new) |
| FY2027/FY2028 overlap | Every query is scoped by an explicit `fiscalYear` parameter — nothing derives "current year" from wall-clock time anywhere in this session's code |

## 7. Regression sweep — actually executed, this session, on the final candidate

```text
S2 PASS                                    SESSION2_BOUNDARY_PASS
S3 PASS                                    SESSION3_BOUNDARY_PASS
defense-api routes: 49 exact               confirmed via verify-phase8-session3.mjs
SESSION3_ADMIN_BOUNDARY_PASS               confirmed
S4 SOURCE_PARITY_PASS                      (--enforce-replay, with evidence env var)
S5 full provider/NVIDIA negative suite     PASS (79 checks) — SESSION5_COMPLETE_NVIDIA_NOT_ADOPTED
S6 PASS                                    SESSION6_FEDERAL_FUNDING_FOUNDATION_PASS
S7 domain 57/57                            PASS
S7 control loop 32/32                      PASS (lifecycle-watcher.spec.ts)
S7 PASS (static)                           SESSION7_LIFECYCLE_CONTROL_PLANE_PASS
S8 discovery 40/40                         PASS
S8 publisher-native 15/15                  PASS
S8 control loop 15/15                      PASS (live-discovery.spec.ts)
S8 PASS (static)                           SESSION8_LIVE_DISCOVERY_PASS
S9 domain 36/36                            PASS
S9 runtime 30/30                           PASS (provider-runtime.spec.ts)
S9 PASS (static)                           SESSION9_PROVIDER_RUNTIME_PASS
S10 domain 18/18                           PASS
S10 coordinator 10/10                      PASS (schedule-coordinator.spec.ts)
S10 PASS (static)                          SESSION10_SCHEDULE_CONTROL_PLANE_PASS
S11 domain 10/10                           PASS (buildScheduleTickHealth)
S11 query-service spec 6/6                 PASS
S11 PASS (static)                          SESSION11_PRODUCT_INTEGRATION_PASS
S8 DB rehearsal / S9 DB 43/43 / S10 DB 39/39   NOT RE-RUN — Docker unavailable in this sandbox (§5)
S11 DB rehearsal                           NOT RUN — same reason (§5); script written and ready
defense-api typecheck + build              PASS (clean)
apps/web typecheck                         PASS (clean, whole app)
apps/web tests (this module + full VNextRouter suite)  61/61 PASS, zero regressions
apps/api prisma validate                   PASS
defense-api prisma validate                PASS
apps/api typecheck baseline                 16 errors, byte-identical category set to the documented main baseline (4 rootDir + 1 alert-memo + 2 memory + 6 meri + 3 reviews)
git diff --check                           clean
```

## 8. Commands

```bash
pnpm verify:phase8-session11
pnpm verify:phase8-session11:domain
pnpm verify:phase8-session11:runtime
pnpm verify:phase8-session11:db   # requires a working Docker daemon
```

**`SESSION11_NOT_READY`** — the disposable-database rehearsal (§5) was not
executed in this session. Every other gate in §7 is real and green. This is
not a code defect; re-run `pnpm verify:phase8-session11:db` in an environment
with a working Docker daemon before declaring the session complete.

**Do not merge until separately authorised.**
