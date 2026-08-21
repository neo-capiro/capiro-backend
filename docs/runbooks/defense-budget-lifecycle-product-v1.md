# Defense Budget Lifecycle Product/Read — Operator Runbook (v1)

**Session:** Phase 8 Session 11
**Status at authoring:** implementation complete, dark. Not activated. No
AWS resource created or modified by this session.

---

## 1. What this is, in one paragraph

Sessions 7-10 built a complete control plane for discovering, classifying and
scheduling official defense-budget source documents, but registered no HTTP
route and no aggregate read model for any of it — `CycleHealthService` itself
says so in its own file header. Session 11 adds exactly that: a read-only
HTTP surface (`BudgetLifecycleReadController`, new module
`BudgetLifecycleProductModule`) over the Session 7-10 tables, plus one new
domain aggregator (`buildScheduleTickHealth`) for the tick-history gap the
Session 10 handoff named explicitly. It also adds the one governed CLI
command capable of resolving a `review_required` hold, because the database
grants Session 7 wrote (`capiro_defense_serve`: SELECT only;
`capiro_defense_job`: the only writer) make that a job-role action, never an
HTTP one.

## 2. What this runbook does NOT cover

- **Activation.** Registering a NestJS route is not the same as receiving
  production ALB traffic. Nothing in this session deploys, and nothing
  changes which surfaces `os.capiro.ai`/`app.capiro.ai` actually route to.
- **Any HTTP mutation.** There is no POST/PUT/PATCH/DELETE route anywhere in
  `BudgetLifecycleReadController`. `scripts/verify-phase8-session11.mjs`
  enforces this structurally, not just by convention.
- **Signal persistence.** `defense_budget_lifecycle_signal` still has no
  writer. Session 11's `/signals` endpoint computes `deriveLifecycleSignals`
  read-time, on every request, over stored observation history; nothing is
  cached or persisted.
- **The DB connection role cutover.** `capiro_defense_serve`/
  `capiro_defense_job` exist and carry the right grants (Session 2), but
  defense-api's actual runtime connection has not yet been repointed to log
  in as either — that cutover is still deferred, exactly as Session 2's own
  closeout recorded. This session's read/write split is a design boundary
  today, backed by real grants once the cutover lands; it is not yet
  mechanically enforced by the live connection.

## 3. The read API

All of the following require a real Capiro session (Clerk) resolving to an
active `defense-api` membership — same guard chain as the frozen Session 3
routes (`TenantGuard` → `DefenseMemberResolverGuard` → `RolesGuard`,
`standard_user` minimum). None of this domain's tables carry a `tenant_id`:
official government budget documents are global reference data, so the guard
chain authenticates a real member; it does not filter rows per tenant.

```
GET budget-lifecycle/cycles/:fiscalYear/health
GET budget-lifecycle/cycles/:fiscalYear/expected-sources?authorityTrack=&expectedState=
GET budget-lifecycle/expected-sources/:id
GET budget-lifecycle/cycles/:fiscalYear/review-queue
GET budget-lifecycle/cycles/:fiscalYear/signals
GET budget-lifecycle/schedule/tick-health
```

None of these routes are in `DEFENSE_PUBLIC_ROUTES` (still frozen at exactly
49) — they live in their own table,
`DEFENSE_BUDGET_LIFECYCLE_PRODUCT_ROUTES`, in
`packages/defense-contracts/src/public/budget-lifecycle-product-routes.ts`.

## 4. The governed review-resolution command

```bash
cd apps/defense-api

# Read-only. Lists every review_required expected source for one fiscal
# year, with its review reasons, discovered URL and content sha.
DATABASE_URL=... node scripts/run-review-resolution.mjs --list --fiscal-year 2027

# Validates the arguments and the item's current state, reports what WOULD
# happen, and writes nothing.
DATABASE_URL=... node scripts/run-review-resolution.mjs \
  --expected-source-id <uuid> --decision published \
  --note "verified against the publisher's own package page" \
  --actor-user-id <uuid> --tenant-id <uuid>

# The only path that writes anything.
PHASE8_SESSION11_REVIEW_RESOLUTION_AUTHORIZED=true \
  DATABASE_URL=... node scripts/run-review-resolution.mjs \
  --expected-source-id <uuid> --decision published \
  --note "verified against the publisher's own package page" \
  --actor-user-id <uuid> --tenant-id <uuid> --commit
```

`--decision` must be one of `expected | not_filed | published | withdrawn |
unavailable` — the states being resolved INTO, never `review_required`
itself. The command refuses if the item is not currently `review_required`
(a concurrent resolution, or a new watcher observation, may already have
moved it), which is what makes retrying after a failed audit-log write safe:
a retry either finds the same row (safe to resolve again) or finds it
already resolved (refuses loudly).

The write itself calls the frozen Session 7
`LifecycleStore.setExpectedSourceState` — the exact method the watcher
itself uses to move a source INTO review — and separately writes one
`audit_logs` row (`action = 'defenseBudgetLifecycle.reviewQueue.resolve'`,
`before`/`after` capturing the state transition and the operator's note).
The two writes are not one database transaction; see the script's own header
comment for why, and why the precondition re-check makes that an acceptable,
disclosed limitation rather than a silent risk.

## 5. Verification commands

```bash
pnpm verify:phase8-session11          # static structural gate
pnpm verify:phase8-session11:domain   # buildScheduleTickHealth unit tests
pnpm verify:phase8-session11:runtime  # BudgetLifecycleQueryService spec
pnpm verify:phase8-session11:db       # disposable-Postgres rehearsal
```
