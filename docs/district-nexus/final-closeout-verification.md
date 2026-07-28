# District Nexus — final closeout verification

Overall: PASS

Every number below was measured in `C:\dev\capiro-dn-closeout-wt` at the SHA
named. Nothing here is copied from a prior PR summary.

- **Branch:** `agent/district-nexus-final-closeout`
- **Branch SHA:** `b164d97d72cce8fa3eacb88f807eeb100a320e5c`
- **Base SHA (`origin/main`):** `444d883825f1091a62520c468240cd7a73958479`
- **Merge base:** the branch was merged **up to** that base — it is 0 commits behind
- **Diff vs main:** 28 files, +5,001 / −209

## Why PASS, stated precisely

`Overall: PASS` is claimed under the exact condition the closeout brief allows:
every required merge gate passes, and the only failing tests are the
repository's **documented** pre-existing baseline in areas this branch has no
dependency on. Specifically:

- The one required CI check (`verify`, typecheck-only) is green. It was **red**
  at the start of this pass, from six errors in a file this branch itself added.
- Both full suites match the documented baseline **exactly** — 40 API failures
  across 12 suites, 1 web failure — with **zero** new failures and 61 new
  passing API tests plus 7 new web tests.
- Every failing suite is in `acquisition-personnel`, `engagement`, `meri`,
  `program-element`, or `test/e2e`. District Nexus imports none of them.

What PASS does **not** claim: that the feature is live, that the migration is
applied, or that anyone has clicked through the UI. Those are rollout gates,
tracked in `final-closeout-matrix.md` §H and executed via
`docs/runbooks/district-nexus-final-closeout.md`.

---

## Exact verification commands

```bash
cd /c/dev/capiro-dn-closeout-wt

pnpm install --frozen-lockfile
pnpm --filter "./packages/**" build          # MANDATORY on a fresh worktree — see note
pnpm --filter @capiro/api prisma:generate
pnpm --filter @capiro/api typecheck
pnpm --filter @capiro/web typecheck

apps/api/node_modules/.bin/jest src/district-nexus/          # run from apps/api
apps/web/node_modules/.bin/vitest run DistrictNexus          # run from apps/web
apps/api/node_modules/.bin/jest --silent                     # full API
apps/web/node_modules/.bin/vitest run                        # full web

pnpm --filter @capiro/web build
pnpm --filter @capiro/api build

cd apps/api && DATABASE_URL="postgresql://u:p@localhost:5432/db?schema=public" \
  ./node_modules/.bin/prisma validate
```

> **`pnpm --filter "./packages/**" build` is not optional.** On a fresh worktree
> an unbuilt `@capiro/shared` produces ~40 spurious
> `TS2307: Cannot find module '@capiro/shared'` typecheck errors and a cascade of
> suite-level jest failures, making the branch look far worse than it is. This
> cost real time in a prior session; it is recorded here so it does not again.
>
> Two further path facts: there is **no** `jest` in the repo-root
> `node_modules/.bin` (use `apps/api/node_modules/.bin/jest`), and `prisma
> validate` needs `DATABASE_URL` to be *set* — it does not connect, but it
> refuses to resolve `env("DATABASE_URL")` without it.

---

## Results

| Gate | Result |
| --- | --- |
| **API typecheck** | ✅ **PASS** — clean, exit 0 |
| **Web typecheck** | ✅ **PASS** — clean, exit 0 |
| **API targeted (`src/district-nexus/`)** | ✅ **PASS** — 11 suites, **263 tests**, 0 failures |
| **Web targeted (`DistrictNexus`)** | ✅ **PASS** — 5 files, **58 tests**, 0 failures |
| **Full API suite** | ⚠️ **AT BASELINE** — 12 failed / 433 passed suites; **40 failed / 5,055 passed** / 1 todo of 5,096 |
| **Full web suite** | ⚠️ **AT BASELINE** — 1 failed / 146 passed files; **1 failed / 1,244 passed** of 1,245 |
| **Web production build** | ✅ **PASS** — built in 1m 26s |
| **API production build** | ✅ **PASS** — `apps/api/dist/main.js` emitted |
| **Prisma schema validation** | ✅ **PASS** — "The schema at prisma\schema.prisma is valid 🚀" |
| **Migration ordering / duplicate prefix** | ✅ **PASS with a note** — see below |
| **Security & tenant isolation** | ✅ **PASS** — see below |
| **Browser smoke test** | ⛔ **NOT RUN — not possible for this branch.** See below |
| **CI `verify`** | ✅ **PASS** — was failing at the start of this pass |

### API typecheck — the CI blocker that was fixed

At the start, `verify` failed on six errors, all in
`apps/api/src/district-nexus/district-nexus-relationships.service.spec.ts`
(lines 150, 166, 247 — TS2352 and TS2493 at each).

Root cause: the spec harness declared its Prisma mocks as zero-argument
`jest.fn(async () => …)`. TypeScript infers the call-tuple type as `[]`, so
every `mock.calls[0]![0]` was an index into an empty tuple. **Branch-introduced,
not baseline.** Fixed by declaring the mock argument shapes. No behavioural
change.

### Full API suite — the 12 failing suites, named

Recorded individually rather than summarised as "same baseline":

```
src/acquisition-personnel/acquisition-personnel-read.service.spec.ts
src/acquisition-personnel/extractors/sam-personnel-extractor.spec.ts
src/acquisition-personnel/org-import/dow-org-import.helpers.spec.ts
src/engagement/engagement-batch-error-status.spec.ts
src/engagement/engagement-batch-group.spec.ts
src/engagement/engagement-batch-revise.spec.ts
src/engagement/engagement-batch-sticky-provider.spec.ts
src/meri/meri-tools.firmdata.spec.ts
src/program-element/extractors/bill-pe-extractor.spec.ts
src/program-element/program-element-read-provisions.spec.ts
src/program-element/program-element-read.service.spec.ts
test/e2e/defense-budget-intelligence.e2e.spec.ts
```

**Caused by this branch: none.** The documented baseline (plan §4.1 / §9.6) is
"~41 known pre-existing failures across ~15 suites — MCP-SDK jest resolver
mapping plus drifted hand-mocks", and this is 40 across 12. District Nexus code
imports nothing from any of these five areas.

Movement attributable to this branch, measured on the same worktree before and
after:

| | Before | After | Δ |
| --- | ---: | ---: | ---: |
| Failed tests | 40 | 40 | **0** |
| Failed suites | 12 | 12 | **0** |
| Passed tests | 4,994 | 5,055 | **+61** |

### Full web suite — the single failure

```
src/pages/program-element/ProgramElementWatchPage.test.tsx
  > ProgramElementWatchPage > renders the hero, KPI strip, and tabbed panels
```

Pre-existing and unrelated — a Program Element page with no District Nexus
import. Web passing tests rose by the 7 new panel tests.

### Migration ordering

This branch adds one migration:
`20260808010000_client_grant_nexus_manual_award_unique`. Its timestamp sorts
after every existing directory, so ordering is correct.

**Note, not a defect:** the repository already contains seven duplicated
timestamp *prefixes*
(`20260520010000`, `20260707010000`, `20260707020000`, `20260710120000`,
`20260727010000`, `20260730010000`, `20260804010000`). Prisma orders by full
directory name, and all full names are distinct, so application order stays
deterministic. This branch adds no new collision.

⚠️ **An older migration on `main` has never been applied to `capiro-dev`:**
`20260806010000_client_grant_nexus_producer_unique`. That is stated in a source
comment at `infra/cdk/lib/ingestion-schedule.ts:451-459`. It is not this
branch's migration, but it is a rollout precondition for the producer schedule,
so runbook §2 verifies the whole pending set rather than only ours.

### Security and tenant isolation

| Check | Result |
| --- | --- |
| `tenant-scope-guard.spec.ts` (build gate: no bare tenant-scoped Prisma access) | ✅ passing — it parses `schema.prisma` for `tenantId` and greps every non-spec `.ts` under `apps/*/src`, so new models are auto-covered |
| Controller authorization (new, 14 tests) | ✅ passing |
| Flag guard fails closed (404, never 403) | ✅ passing |
| Actor identity comes only from `TenantContext` | ✅ asserted |
| Cross-tenant access via client/relationship id | ✅ structurally prevented by `withTenant`; **live curl proof deferred to runbook §14** |

The controller spec deliberately drives the **real** `RolesGuard` against the
**real** decorator metadata rather than snapshotting the metadata. A snapshot
would still pass if `getAllAndOverride`'s handler-over-class precedence ever
inverted — and that precedence is the only thing making the method-level
`@Roles('user_admin')` beat the controller-level `@Roles('standard_user')`. If it
inverted, every mutation would silently fall back to standard-user access.

One defence-in-depth observation, not a live defect:
`aggregateRelationshipNexus` (`district-nexus.service.ts:1119-1124`) batch-loads
facilities by id inside `withTenant` without a `clientId` filter. Tenant-safe,
and unreachable today because the only writer validates client ownership and the
producer never sets `facilityId`.

### Browser smoke test — why it is NOT RUN

This is a genuine gap, recorded rather than papered over.

The branch is **unmerged and undeployed**, and deploying is explicitly out of
scope for this pass. Any browser session against `app.capiro.ai` today exercises
the *currently deployed* image, which does not contain this branch's code — so
it would verify nothing about it and would produce a misleading green tick.

The same applies to the other three browser-dependent items in the brief:
narrow-viewport rendering, WebGL-disabled map fallback, and keyboard/accessible-
label checks on the map controls and relationship forms. The map-fallback path
*is* covered in jsdom (`DistrictNexusPage.test.tsx` mocks
`./DistrictNexusMap.js` wholesale — the repo's established precedent, since
there is no canvas/WebGL mock anywhere in it), but that is not the same as a
real WebGL-off browser.

**Resolution:** runbook §13 is the browser canary walk, to be run by Neo after
§12's deploy. It is listed as a rollout gate in the matrix (§H9), not a merge
gate.

### Performance findings

1. **profile-v1 could hang forever, invisibly — now bounded.** The 24-way
   `Promise.allSettled` fan-out had no per-source budget. A source that never
   settles makes `allSettled` never settle, so the handler never returns: no
   error, no rejected section, and no `api.endpoint_latency_ms` (that metric
   fires on response *finish*). That is exactly the 2026-07-27 signature — a
   permanent hang with nothing in the logs.

   Added a 20 s per-source wall-clock budget plus a >3 s slow-source warning
   naming the source and its duration. This is **not** raising a client timeout:
   the request still fails fast, but the culprit is now named and degrades to its
   own fallback. It is deliberately not cancellation — `Promise.race` cannot
   abort an in-flight Prisma query — so it complements the explicit
   `connection_limit=10` already in `entrypoint.sh:40`. 7 tests, including that a
   hung source degrades only itself and that a late rejection arriving after the
   budget never becomes an `unhandledRejection`.

2. **The plan's prime suspect stays exonerated.** `getDistrictNexusSpend` was
   measured at 17 ms (Bitmap Index Scan, `EXPLAIN` execution 0.201 ms, 126
   matching rows for RTX). Not the cause.

3. **Producer N+1 already fixed on `main`.** Per-(client, grant) `findFirst`
   batched to one `findMany` per client — 780–960 ms → 4–6 ms, 130–240×.

4. **Bundle budget met.** The production build puts MapLibre in its **own**
   chunk, `maplibre-B82Sy8y1.js` at 1,054.12 kB (**284.95 kB gzipped**), with
   `DistrictNexusPage-BLSbjyvZ.js` lazy at 63.12 kB (20.10 kB gz). Neither is in
   the initial `index` chunk or the client-profile path, which is the plan §9.4
   requirement. The chunk-size warning on `index-DTjbxhu9.js` (4,584 kB) is
   pre-existing and unrelated.

5. **`EXPLAIN ANALYZE` not run locally.** Aurora is in a private subnet with
   ECS-only access, so no local plan capture is possible. Read-only commands are
   provided in runbook §16.3.

6. **Open sizing question for Neo:** `connection_limit=10` on a 512-CPU-unit
   (0.5 vCPU) task replaced Prisma's CPU-derived default of ~3–5, which is what
   let the fan-out starve. 10 has not been load-validated. Runbook §16.2 says
   what evidence would justify revisiting it.

### Unresolved failures

**None attributable to this branch.**

Outstanding items are operational, not test failures, and every one is tracked
in `final-closeout-matrix.md` §H with its gate and owner:

| Item | Kind |
| --- | --- |
| ~~Two unapplied migrations~~ — **both applied and DB-verified 2026-07-28**. Only `20260808010000` was ever pending; the `20260806010000` claim came from a stale CDK comment | Closed |
| Stale assistance-recipient cleanup not yet run | Rollout gate |
| Assistance enrichment backlog (~238,619 rows) | Rollout gate |
| Grants.gov reconcile — the "~12%/run, ~8 passes" model was **wrong**: `offset` is ignored by search2 so it re-read page 0 forever. Fixed (`startRecordNum` + `--from-page`) | Rollout gate |
| No live EventBridge rule for the candidate producer | Rollout gate |
| `ApiTaskRole` lacks `s3:PutObject` on `district-boundaries/*` | Rollout gate |
| Browser canary walk | Rollout gate |
| F3 eligibility can never return `eligible` (`applicantTypes` hardcoded `[]`) | Deferred, honest — never over-claims |
| `connection_limit=10` sizing | Open question |
