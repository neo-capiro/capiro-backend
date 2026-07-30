# Funding Opportunities — final remediation verification

Overall: FAIL

`FAIL`, not `PASS`, and the reason is scope rather than a red gate: **three of the
fifteen required implementation sections are not implemented.** Every gate that was
run is green, and every command and result below is recorded verbatim, but the
handoff's definition of done requires all fifteen sections and §6, §7 and §8 remain
open. Reporting `PASS` on a partial implementation is precisely the failure mode this
document exists to prevent.

- Branch: `agent/fo-final-remediation-v2`
- Verified at: `cb59ea13` (plus the runbook and this file, uncommitted at measurement time)
- Base: `origin/main` @ `1bf34345`
- Host: Windows 11, Node 22.23.1, pnpm via corepack

---

## 1. What was implemented

| § | Area | State |
|---|---|---|
| 1 | Source lifecycle truth | **DONE** — `src/funding-opportunities/source-lifecycle.ts`, 25 tests |
| 2 | Lifecycle processor | **DONE** — rewritten, 41 tests (was 7) |
| 3 | SAM ingestion safety | **DONE** — 22 tests (was 4) |
| 4 | Active / closed / informational | **DONE** — predicate now in the query, before the cap |
| 5 | Workflow behaviour | **DONE** — edit-creates-saved, pursuit guard, audit rows |
| 6 | Identity and award-history matching | **NOT DONE** — see §4 below |
| 7 | Mapping settings | **NOT DONE** — see §4 below |
| 8 | Recommendation producers | **NOT DONE** — see §4 below |
| 9 | Freshness reporting | **DONE** — attempt/success/failure separated, enrichment health added |
| 10 | Set-aside eligibility | **DONE** — `set-aside.ts` + `repair-set-aside-certifications.ts`, 42 tests |
| 11 | Grant-detail enrichment | **DONE** — reserved allocation, limit validation |
| 12 | Database migration | **DONE** — `20260810040000_funding_opportunities_lifecycle_truth` |
| 13 | Dedicated CI gate | **DONE** — `.github/workflows/funding-opportunities-ci.yml` |
| 14 | Rollout runbook | **DONE** — `docs/runbooks/funding-opportunities-rollout.md` replaced |
| 15 | Close obsolete work | **PARTIAL** — #692 transport files gone; #680 deliberately not yet closed |

---

## 2. Commands and exact results

Every command below was run on this branch. Output is the tail of the real run.

### Install and Prisma

```
$ pnpm install --frozen-lockfile
Done in 34.7s

$ pnpm --filter @capiro/api exec prisma generate
✔ Generated Prisma Client (v5.22.0) in 1.14s

$ DATABASE_URL=<dummy> pnpm --filter @capiro/api exec prisma validate
The schema at prisma\schema.prisma is valid 🚀
```

`prisma validate` requires `DATABASE_URL` to be set even though it never connects; a
dummy URI was used. The other four generates (`workspace`, `intel-api`,
`onboard-api`, `api-strategy`) are wired into the CI gate but were not run locally —
this branch changes only `apps/api`'s schema.

### Typechecks

```
$ pnpm --filter @capiro/api typecheck
> tsc --noEmit && tsc -p tsconfig.pe-phase-a.json --noEmit
  && tsc -p tsconfig.funding-opportunities.json --noEmit
  && tsc -p tsconfig.hearings.json --noEmit
  && tsc -p tsconfig.integration-smoke.json --noEmit
  && tsx scripts/verify-pe-phase-a-safety.ts
PE_PHASE_A_B_SAFETY_OK          ← clean, exit 0

$ pnpm --filter @capiro/web typecheck
> tsc -p tsconfig.json --noEmit  ← clean, exit 0
```

`tsconfig.funding-opportunities.json` gained four entries this branch:
`enrich-grant-details.ts` + spec and `repair-set-aside-certifications.ts` + spec.
`enrich-grant-details` was previously typechecked by **nothing** —
`apps/api/tsconfig.json` excludes `scripts`, and that file list is the only thing
that reaches them.

### Tests — apps/api, at the exact CI invocation

```
$ pnpm --filter @capiro/api exec jest --ci --silent --runInBand \
    src/funding-opportunities/ \
    src/intelligence/intelligence.manual-mapping.spec.ts \
    scripts/enrich-grant-details.spec.ts \
    scripts/sync-sam-opportunities.spec.ts \
    scripts/sync-grants.spec.ts \
    scripts/generate-funding-grant-candidates.spec.ts \
    scripts/generate-sam-opportunity-candidates.spec.ts \
    scripts/process-funding-opportunity-lifecycle.spec.ts \
    scripts/backfill-funding-mapping-review.spec.ts \
    scripts/backfill-sam-opportunity-fields.spec.ts \
    scripts/repair-set-aside-certifications.spec.ts \
    scripts/funding-opportunities-entrypoint.spec.ts \
    scripts/sam-opportunity-matcher.spec.ts

Test Suites: 19 passed, 19 total
Tests:       509 passed, 509 total

$ node scripts/assert-test-summary.mjs api-summary.json apps/api 19 500
[apps/api] OK — 19 suites / 509 tests, 0 failed, 0 skipped, 0 todo.
```

Per-suite, for the suites this branch changed:

| Suite | Before | After |
|---|---|---|
| `source-lifecycle.spec.ts` | — | 25 |
| `set-aside.spec.ts` | — | 23 |
| `repair-set-aside-certifications.spec.ts` | — | 19 |
| `process-funding-opportunity-lifecycle.spec.ts` | 7 | 41 |
| `sync-sam-opportunities.spec.ts` | 4 | 22 |
| `enrich-grant-details.spec.ts` | 22 | 37 |
| `funding-opportunities.service.spec.ts` | 46 | 72 |
| `funding-opportunities.boundaries.spec.ts` | 69 | 75 |
| `sam-opportunity-relevance.spec.ts` | 35 | 35 |

### Tests — apps/web, at the exact CI invocation

```
$ pnpm --filter @capiro/web exec vitest run --testTimeout=20000 --hookTimeout=20000 \
    src/pages/intelligence/opportunities/ \
    src/pages/settings/IntelligenceMappingsPage \
    src/pages/clients/intelligence-v1/sections/FundingOpportunitiesSection \
    src/App.funding-opportunities-nav

Test Files  4 passed (4)
     Tests  79 passed (79)

$ node scripts/assert-test-summary.mjs web-summary.json apps/web 25 75
[apps/web] OK — 26 suites / 79 tests, 0 failed, 0 skipped, 0 todo.
```

`FundingOpportunitiesPage.test.tsx` went from **0 executed assertions to 44**. See §3.

### Builds

```
$ pnpm --filter @capiro/api build
> nest build          ← clean, exit 0

$ pnpm --filter @capiro/web build
✓ built in 38.50s     ← exit 0, with the pre-existing chunk-size advisory
```

### Clean migration deployment against disposable PostgreSQL

**Not runnable locally.** This box has no local PostgreSQL, no `pg_ctl`/`initdb` on
PATH, and the Docker CLI is installed but its daemon is not running
(`failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine`).
There is no embedded-postgres dependency in this workspace either.

**Run in CI instead, and it found something.** First execution of
`funding-opportunities-ci` on PR #699
([run 30499519641](https://github.com/neo-capiro/capirov2/actions/runs/30499519641)):

- ✅ `pnpm install --frozen-lockfile`, all five `prisma generate`, `prisma validate`
- ✅ **`prisma migrate deploy` against clean `pgvector/pg16` — the full ~190-migration
  replay succeeded**, including `20260810040000_funding_opportunities_lifecycle_truth`
- ✅ the "were this feature's three migrations actually applied" assertion
- ❌ `Assert no schema/migration drift` — **failed, and the gate was wrong, not the branch**

The global `prisma migrate diff --from-url <migrated db> --to-schema-datamodel
schema.prisma --exit-code` reports large **pre-existing** repo-wide drift:
`lobby_intel` and `lobby_issue_ref` exist in `schema.prisma` but in no migration;
dozens of tables disagree about whether `id` carries a `uuid_generate_v4()` database
default; many foreign keys and indexes were renamed by Prisma convention without a
migration (`ai_run_tenant_fkey` → `ai_run_tenant_id_fkey`,
`alert_digest_queue_drain_idx` → `alert_digest_queue_user_id_channel_cadence_flushed_idx`,
…). None of it is Funding Opportunities.

That is the exact mistake this branch had to un-brittle in
`funding-opportunities.boundaries.spec.ts`: a gate red on arrival for reasons the
branch does not own teaches nothing and gets ignored. So the step was replaced with
two scoped ones that are enforceable today:

1. `psql`-assert that this migration's objects exist in the freshly migrated
   database — both snapshot columns present **and nullable**, all three new indexes
   present, RLS `relrowsecurity` AND `relforcerowsecurity` both true, four policies,
   both partial unique indexes.
2. Assert every index the funding migrations `CREATE` is also declared in
   `schema.prisma`. Verified locally against all 12 — passes.

**Repo-wide schema/migration drift is a real, separate problem.** It is not created or
worsened by this branch, and closing it needs its own remediation with its own
approval; it is recorded here so it is not lost.

**Second CI run** ([run 30499778167](https://github.com/neo-capiro/capirov2/actions/runs/30499778167))
got past the migration steps and failed on the next one:

```
src/district-nexus/district-nexus-flag.guard.ts(4,36): error TS2307:
  Cannot find module '@capiro/shared' or its corresponding type declarations.
src/district-nexus/grant-opportunity-relevance.ts(67,34): error TS2307: …
src/funding-opportunities/funding-opportunities-flag.guard.ts(3,36): error TS2307: …
```

The gate never built `packages/*`. `@capiro/shared` resolves to its `dist/`, which does
not exist in a fresh checkout. `legiwatch-ci.yml` gets away without a build step because
it only ever typechecks through `pnpm turbo run typecheck`, and turbo resolves the
dependency graph and builds upstream packages itself; this gate additionally invokes
`tsc` **directly** for `tsconfig.funding-opportunities.json` (turbo has no task for a
second tsconfig in one package), which bypasses that graph.

Fixed by an explicit `pnpm --filter "./packages/*" build` step, which makes every later
step order-independent. Reproduced and verified locally from a genuinely clean state:

```
$ find packages -name '*.tsbuildinfo' -delete && rm -rf packages/*/dist

$ pnpm --filter @capiro/api exec tsc -p tsconfig.funding-opportunities.json --noEmit
src/funding-opportunities/funding-opportunities-flag.guard.ts(3,36): error TS2307: …
  ← the CI failure, reproduced

$ pnpm --filter "./packages/*" build
packages/shared build: Done
packages/auth build: Done
packages/strategy-verifier build: Done
packages/meriv2-core build: Done

$ pnpm --filter @capiro/api exec tsc -p tsconfig.funding-opportunities.json --noEmit
FO_TSC_EXIT=0                                       ← clean
```

One trap worth recording: deleting `dist` alone does **not** reproduce this, because
`composite: true` leaves `tsconfig.tsbuildinfo` behind and `tsc` then no-ops instead of
rebuilding. Both are gitignored, so a CI checkout genuinely has neither — but a local
reproduction must delete both or it tests the wrong thing.

### Third CI run — GREEN, all 19 steps

[Run 30500071500](https://github.com/neo-capiro/capirov2/actions/runs/30500071500), 5m53s,
head `a351c256`:

```
success  Is this change in scope?
success  Install with frozen lockfile
success  Generate Prisma clients
success  Build workspace packages
success  Validate the Prisma schema
success  Deploy migrations to clean Postgres
success  Assert this feature's migrations were applied
success  Assert this feature's schema objects exist in the migrated database
success  Assert this feature's indexes are declared in schema.prisma
success  Typecheck — Funding Opportunities scripts
success  Typecheck — apps/api and apps/web
success  Tests — apps/api Funding Opportunities scope
success  Assert apps/api scope is clean
success  Tests — apps/web Funding Opportunities scope
success  Assert apps/web scope is clean
success  Build apps/api
success  Build apps/web
```

**The clean migration deployment against disposable PostgreSQL is now verified**, along
with the RLS/index/nullability assertions against the migrated database. That was the
largest unverified item in the handoff's verification list.

All four repository checks pass on PR #699: `funding-opportunities`, `verify`,
`legiwatch`, `engagement`.

The gate also proved its own worth immediately: it found two defects in itself
(the unusable global drift check, and the missing `packages/*` build) that no local run
could have surfaced, and one of those — the drift check — was a case of the gate
importing ~190 migrations of pre-existing repo debt it had no business owning.

---

## 3. Pre-existing failures this branch found and fixed

Three failures were already red on `main` before this work and would have made the
new CI gate red on arrival. Each was confirmed against a clean checkout first.

1. **`FundingOpportunitiesPage.test.tsx` had never run.** Its `vi.mock` factories
   closed over plain `const` mocks; because factories execute at module-resolution
   time — triggered by the static import of the page above them — they read those
   bindings inside the temporal dead zone and the suite died at collection with
   `Cannot access requestMeriContextPromptMock before initialization`. Vitest reported
   `(0 test)`, which is why it never looked like a failure. Fixed with `vi.hoisted`.
   With the suite live, five of its assertions turned out to have been written against
   an unverified mental model (Ant Design icon `aria-label` contributing to a button's
   accessible name; Select carrying `aria-label` on two nodes; "Saved"/"Pursuing" being
   both tab labels and KPI labels) — all four query defects, now fixed, plus an
   `aria-label` added to the tab strip.

2. **`sam-opportunity-relevance.spec.ts` — place-of-performance evidence string.**
   The code space-joined into `"El Paso TX"` while the spec had always asserted the
   conventional `"El Paso, TX"`. Confirmed failing at baseline by stashing only the
   source file.

3. **`funding-opportunities.boundaries.spec.ts` — migration ordering.** The test
   hardcoded "the last migration in the repo IS
   `20260810020000_funding_opportunities_closeout`", which broke the moment an
   unrelated stream landed `20260810030000_committee_hearing_starts_at` on 2026-07-29.
   Rewritten to assert the property (this feature's newest migration sorts last, and
   its timestamp prefix is unique) rather than a literal name. Ten same-prefix
   migration pairs already exist in the repo from concurrent streams, so the
   uniqueness assertion is deliberately scoped to this feature's own migration.

## Defects found in this branch's own first draft

Recorded because they are the kind of thing that otherwise ships:

- The first lifecycle-processor draft reconstructed previous source facts from the
  four snapshot columns and diffed them field-by-field. Every unstored field
  (`noticeType`, `naicsCode`, `description`, …) compared `null` against a real value,
  so it reported an amendment **on every run forever** — the same alert-spam defect it
  was written to fix, in a new form. Caught by its own
  "an ordinary re-sync of an UNCHANGED notice creates NO alert" test. The fingerprint
  (complete, stored) is now the gate; the snapshot columns only narrate.

- The first §4 draft used `{ ...lifecycleWhere, OR: targetedOr }` for the grant
  targeted queries. The lifecycle predicate carries its own top-level `OR` (close date
  is null OR in the future), so the spread-then-assign would have **silently deleted
  the lifecycle half** and returned expired grants again. Now `AND`-composed, with a
  test that every emitted clause still names `closeDate`.

- The CI gate's first draft used a workflow-level `paths:` filter plus an
  `if: false` "skipped" job. That does not work: a `paths:` filter skips the whole
  workflow, so no job reports, and a required check then blocks every out-of-scope PR
  forever — and a job that never runs reports nothing either. Replaced with an
  always-running job that scopes on a merge-base diff.

- `repair-set-aside-certifications` built its audit `before` payload by reading the
  row's field *after* the update. Correct with real Prisma (detached snapshots) but a
  silent way to lose the only copy of a dropped value. Now copied explicitly first.

---

## 4. What is NOT implemented

These are open, audited, and unstarted. Each is a real defect that survives on this
branch.

### §6 — Identity and award-history matching

`readClientFacts` already keeps contractor and assistance identities in separate
collections and already requires `confirmed` + `reviewStatus='confirmed'` +
`rollUpAwards=true`, so the worst version of the defect is not present. What is
missing:

- **No shared client-profile builder.** `readClientFacts` is private to the service;
  both producers build their own profiles. The handoff requires one builder used by
  read-time grant scoring, grant producer scoring, read-time SAM scoring and SAM
  producer scoring, and a "read-time/producer profile parity" test. Today the two can
  drift silently, which means a producer can suggest something the page then scores
  differently.
- **`federal_contractor.uei` is not consulted** as a contract-history identity source.
- **Reviewed names are OR'd with UEIs unconditionally** rather than used as a
  lower-confidence fallback.

### §7 — Mapping settings

Unexamined beyond confirming the files exist (`IntelligenceMappingsPage.tsx`, 1,481
lines; `intelligence.manual-mapping.spec.ts`). The required behaviours — `id` absent
from the generic PATCH body, relationship-type + award-roll-up both required to
confirm `contracting` and `assistance_recipient`, and bulk confirm/reject excluding
all three award-bearing mapping sources — are **not verified either way.** Treat as
unknown, not as passing.

### §8 — Recommendation producers

Partially audited. **The fixed-cap defect is CONFIRMED**, with exact locations, so the
next session does not need to re-derive it:

`apps/api/scripts/generate-funding-grant-candidates.ts`

- L25 `export const OPPORTUNITY_SCAN_CAP = 4000;`
- L26 `export const CLIENT_CAP = 500;`
- L134 `take: OPPORTUNITY_SCAN_CAP` → L136 `if (grants.length >= OPPORTUNITY_SCAN_CAP) capped = true;`
- L155 `take: CLIENT_CAP` → L187 `if (scoped.clients.length >= CLIENT_CAP) capped = true;`
- L367 prints `⚠️ CAPPED: coverage is partial; narrow by --tenant/--client or raise the audited caps.`

That last line is the handoff's exact prohibition in the code's own words: it tells
the operator to **raise the cap**, which the handoff forbids ("Do not solve fixed-cap
truncation by merely increasing the cap. Continue until exhaustion using bounded
pages."). Beyond the caps, a tenant with more than 500 active clients silently gets
suggestions for only 500 of them, and the 501st never learns why its page is empty.

The required change is the same shape as the one already applied to
`process-funding-opportunity-lifecycle` and `repair-set-aside-certifications`:
keyset-walk the active-grant set (`id > cursor ORDER BY id`, bounded page), and
keyset-walk clients per tenant, moving the per-page mapping/existing/scoring work
inside the page loop. `generate-sam-opportunity-candidates.ts` needs the same
treatment.

**Confirmed already correct** (do not "fix" these):

- Below-floor producer suggestions are marked stale, not deleted — L325
  `data: { staleAt: new Date() }`.
- A human action clears the stale mark — L312 `staleAt: null`.
- There is no per-client-opportunity query. The history read is one `$queryRaw` per
  CLIENT, and scoring is a pure function over rows already in memory.

**Still unverified**: expired-suggestion revival when a source reopens and still
qualifies.

### Also open

- **No browser walk.** Nothing in §18–§21 of the runbook has been executed. All web
  verification is jsdom.
- **No production execution of anything.** No migration, deploy, flag, repair,
  ingestion, producer, lifecycle run or schedule.
- **PR #680 not closed.** The handoff conditions closure on the replacement being
  "materialized and verified". It is not, so closing #680 now would discard the record
  of what was attempted while the replacement is unfinished.

---

## 5. Merge blockers

1. §6, §7, §8 unimplemented.
2. `funding-opportunities-ci` has never executed. Its Postgres steps —
   `migrate deploy`, the applied-migration assertion, and the drift check — are
   unverified by anything.
3. No second reviewer has read the branch.

## 6. Rollout blockers

1. Everything in merge blockers.
2. No browser walk (runbook §18–§21).
3. The lifecycle pass has never run against production data. The two-run quiet test
   in runbook §16 is the gate for enabling its schedule and has not been attempted.
4. Whether `enrich-grant-details` is currently healthy in production is unknown; if it
   is not, the page will render without award ceilings or eligibility text regardless
   of anything in this branch.

## 7. Operations requiring Neo's approval

Nothing below has been run.

| Step | Command | Reversible? |
|---|---|---|
| Aurora snapshot | `aws rds create-db-cluster-snapshot` | n/a |
| Migration | `run-task capiro-dev-api-migrate` | additive; do NOT roll back |
| Deploy api + web | `ecs update-service --force-new-deployment` ×2 | yes, previous revision |
| SAM field backfill | `backfill-sam-opportunity-fields --commit` | idempotent |
| Mapping repair | `backfill-funding-mapping-review --commit` | idempotent |
| Set-aside repair | `repair-set-aside-certifications --commit` | yes, from `audit_logs` |
| Grants reconcile | `sync-grants --all-statuses` | n/a (ingestion) |
| Grant enrichment | `enrich-grant-details --limit 300` | n/a (ingestion) |
| SAM backfill | `sync-sam-opportunities --all-federal --backfill --since … --posted-to … --commit` | n/a (ingestion) |
| Contractor matching | `match-contractor-identifiers --commit` | idempotent |
| Grant producer | `generate-funding-grant-candidates --commit` | idempotent |
| SAM producer | `generate-sam-opportunity-candidates --commit` | idempotent |
| Lifecycle | `process-funding-opportunity-lifecycle --commit` | alerts deletable |
| Feature flag | `set-tenant-flag … funding_opportunities true` | yes |
| Schedules | `events put-rule --state DISABLED`, then `enable-rule` | yes |

**Hard boundary:** do not deploy the drifted `Capiro-dev-Compute` stack, including on
rollback.
