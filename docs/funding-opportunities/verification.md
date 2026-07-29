# Funding Opportunities — verification

Overall: PASS

That word carries a narrow meaning, so here is exactly what it does and does not
cover.

**PASS means:** every §17 verification command that can run without a live
database or a deployed branch was run against this branch, and each one passed;
and the full `apps/api` and `apps/web` suites show **zero new failures** against
the same `main` SHA the branch is merged up to.

**PASS does not mean the feature works.** No migration has been applied, no image
deployed, no feature flag written, no producer run against real data, and no
browser has ever rendered this surface. Those are rollout blockers RB-1…RB-10 in
[completion-matrix.md](./completion-matrix.md) and steps in
[the rollout runbook](../runbooks/funding-opportunities-rollout.md), and every one
of them is still open. The PR stays a draft.

---

## Environment

| Fact | Value |
| --- | --- |
| Worktree | `C:\dev\capiro-funding-wt` (dedicated; the primary `C:\dev\capirov2` checkout is on an unrelated branch and was not touched) |
| Branch | `agent/funding-opportunities-auto-matching` |
| Code SHA verified | `3e87f8f1` (every command below ran at this SHA; the only later commit is the one adding these docs) |
| `origin/main` SHA | `57a8a5b2c3dee39249ca8f8aebbb2e0fee0965d9` |
| Branch behind main? | **No** — 0 commits behind; `main` was merged in before implementation |
| Baseline worktree | `C:\dev\capiro-fo-baseline-wt`, clean, detached at exactly `57a8a5b2` |
| Node / pnpm | v22.23.1 / 9.12.0 (CI uses node 22, pnpm 9.12.0) |
| OS | Windows 11 |
| Raw logs | one file per command under `C:\dev\fo-verify\logs`, plus `SUMMARY.txt` with exit code and duration per step. Not committed — machine-local paths |

A fresh worktree **must** have `packages/*` built before any `apps/api` test will
run, or every suite fails with `Cannot find module '@capiro/shared'`. Both
worktrees had `auth`, `meriv2-core`, `shared` and `strategy-verifier` built before
these runs. That is a setup step, not a result.

---

## §17 commands and exact results

Exit codes are the real ones, copied from `SUMMARY.txt`.

| # | Command | Exit | Time |
| --- | --- | --- | --- |
| 01 | `pnpm install --frozen-lockfile` | **0** | 2s |
| 02 | `pnpm --filter @capiro/api exec prisma generate` | **0** | 5s |
| 03 | `pnpm --filter @capiro/workspace exec prisma generate` | **0** | 4s |
| 04 | `pnpm --filter @capiro/intel-api exec prisma generate` | **0** | 3s |
| 05 | `pnpm --filter @capiro/onboard-api exec prisma generate` | **0** | 3s |
| 06 | `pnpm --filter @capiro/api-strategy exec prisma generate` | **0** | 3s |
| 07 | `pnpm --filter @capiro/api exec prisma validate` | **1** | 2s |
| 08 | `pnpm --filter @capiro/api typecheck` | **0** | 34s |
| 09 | `pnpm --filter @capiro/web typecheck` | **0** | 11s |
| 10 | `pnpm --filter @capiro/api test -- funding-opportunities` | **0** | 10s |
| 11 | `pnpm --filter @capiro/api test -- grant-opportunity` | **0** | 7s |
| 12 | `pnpm --filter @capiro/api test -- sam-opportunity` | **0** | 6s |
| 13 | `pnpm --filter @capiro/api test -- entity-resolution` | **0** | 7s |
| 14 | `pnpm --filter @capiro/api test -- tenant-scope` | **0** | 7s |
| 15 | `pnpm --filter @capiro/api test -- contractor-identity` | **0** | 6s |
| 16 | `pnpm --filter @capiro/api test -- opportunity-kind` | **0** | 6s |
| 17 | `pnpm --filter @capiro/web test -- FundingOpportunities` | **0** | 33s |
| 18 | `pnpm --filter @capiro/web test -- DistrictNexus` | **0** | 20s |
| 19 | `pnpm --filter @capiro/web test -- IntelligenceMappings` | **0** | 21s |
| 20 | `pnpm --filter @capiro/api build` | **0** | 36s |
| 21 | `pnpm --filter @capiro/web build` | **0** | 48s |
| 22 | `pnpm turbo run typecheck` | **0** | 48s — 18 tasks, 18 successful |
| 31 | `prisma validate` (api, with `DATABASE_URL` set) | **0** | 2s |
| 32 | `prisma validate` (intel-api, same) | **0** | 2s |
| 33 | `prisma validate` (api-strategy, same) | **0** | 2s |
| 34 | `pnpm --filter @capiro/api test -- migration-table-names` | **0** | 17s |
| 35 | `pnpm --filter @capiro/api test` (full, branch) | **1** | 151s |
| 36 | `pnpm --filter @capiro/web test` (full, branch) | **0** | 134s |
| 37 | `pnpm --filter @capiro/api test` (full, baseline `57a8a5b2`) | **1** | 411s |
| 38 | `pnpm --filter @capiro/web test` (full, baseline `57a8a5b2`) | **0** | 136s |

Steps 35 and 37 exit 1 because of the repo's pre-existing failures, which are
identical on both sides — see the comparison below. Every other command exits 0
except step 07, which is explained next.

### Step 07 — the one non-zero exit that is not a defect

`prisma validate` failed with `P1012: Environment variable not found: DATABASE_URL`.
That is the CLI refusing to resolve `env("DATABASE_URL")` in the datasource block;
it is not a schema error, and `prisma generate` (steps 02–06) does not need the
variable. Re-run as steps 31–33 with a deliberately unroutable dummy value
(`postgresql://validate:validate@127.0.0.1:1/validate`) — `validate` parses and
never opens a connection — all three schemas exit **0**.

Recorded rather than quietly replaced, because "I re-ran it until it passed" and
"I supplied the variable the command documents as required" are different claims.

### Step 08 covers the script typecheck gate

`@capiro/api`'s `typecheck` is four commands:
`tsc --noEmit && tsc -p tsconfig.pe-phase-a.json --noEmit && tsc -p tsconfig.funding-opportunities.json --noEmit && tsx scripts/verify-pe-phase-a-safety.ts`.

The third is new in this branch and is the fix for baseline gap **G10**:
`apps/api/tsconfig.json` excludes `scripts`, so no producer script was typechecked
by CI at all. That is the hole PR #651 shipped an uncompilable producer through.
The new project file puts this feature's scripts under `tsc`. It printed
`PE_PHASE_A_B_SAFETY_OK` and exited 0.

---

## Targeted suites — what actually ran

| Command | Suites | Tests | Result |
| --- | --- | --- | --- |
| api `funding-opportunities` | 4 | 161 | all passed |
| api `grant-opportunity` | 3 | 50 | all passed |
| api `sam-opportunity` | 4 | 92 | all passed |
| api `entity-resolution` | 4 | 28 | all passed |
| api `tenant-scope` | 2 | 10 | all passed |
| api `contractor-identity` | 1 | 24 | all passed |
| api `opportunity-kind` | 1 | 23 | all passed |
| api `migration-table-names` | 1 | 2 | all passed |
| web `FundingOpportunities` | 2 | 42 | all passed |
| web `DistrictNexus` | 5 | 58 | all passed |
| web `IntelligenceMappings` | 1 | 12 | all passed |
| web `App.funding-opportunities-nav` | 1 | 6 | all passed |

**These rows are not summable.** The patterns overlap:
`sam-opportunity-relevance.spec.ts` runs under both `funding-opportunities` and
`sam-opportunity`, and `opportunity-kind.spec.ts` under both
`funding-opportunities` and `opportunity-kind`. Across all eight api commands
there are **18 unique suites** (20 runs), every one passing. The 9 web files are
distinct, so the web figures do add up: 118 tests, of which 60 across 4 files
cover this feature and 58 across 5 are the District Nexus regression check.

The `sam-opportunity` pattern is what runs the two **producer** suites
(`scripts/generate-sam-opportunity-candidates.spec.ts`,
`scripts/backfill-sam-opportunity-fields.spec.ts`) — §17's "targeted producer
tests" is covered there, not by a separate command.

`DistrictNexus` is in the list as a **regression** check, not a new-feature one:
this branch rewords District Nexus copy and adds a pointer out of it. All 58
existing assertions still pass.

### A test gap found and closed during verification

§16 requires web tests for the **navigation item** and **route lazy loading**, and
the completion matrix claimed both. Neither had a spec — the 54 pre-existing web
tests all render components below the shell, so nothing asserted the wiring. The
implementation was correct; the coverage claim was not.

`apps/web/src/App.funding-opportunities-nav.test.tsx` (commit `3e87f8f1`, 6 tests)
closes it: the route resolves rather than being swallowed by the
`/intelligence/*` catch-all, the catch-all still redirects everything else, the
page is code-split, the nav entry carries the right label/path/flag, it sits with
the other five Intelligence subtabs, and `pageKeyFor` matches the specific path
before the general `/intelligence` prefix. The matrix row was corrected to say so.

### No skipped tests in the new suites

Grepped for `it.skip`/`test.skip`/`describe.skip`/`xit`/`xdescribe`/`.only`
across every new and modified spec in this branch: **no matches**. The full api
run reports `1 todo`, which is pre-existing —
`test/e2e/defense-budget-intelligence.e2e.spec.ts:822`, an `it.todo` for a
runtime-LLM step, in a suite that is already red at baseline.

---

## Full suite — branch versus the same `main` SHA

Both runs were done sequentially on the same machine, never concurrently: two node
processes at once makes timing-sensitive suites flaky, which would corrupt exactly
the measurement this section exists to make. Baseline ran in
`C:\dev\capiro-fo-baseline-wt`, clean and detached at `57a8a5b2` — the same SHA
this branch is merged up to — with `packages/*` built and a generated Prisma
client, same as the branch worktree.

### `apps/api`

| | Baseline `57a8a5b2` | Branch `3e87f8f1` | Delta |
| --- | --- | --- | --- |
| Suites failed | 12 | 12 | **0** |
| Suites passed | 456 | 463 | +7 |
| Suites total | 468 | 475 | +7 |
| Tests failed | 40 | 40 | **0** |
| Tests passed | 5432 | 5673 | +241 |
| Tests todo | 1 | 1 | 0 |
| Tests total | 5473 | 5714 | +241 |
| Wall clock | 411s (cold transform cache) | 151s (warm) | — |

**The failing sets are identical.** Comparing the two `FAIL` suite lists
name-by-name: nothing fails on the branch that does not fail at baseline, and
nothing that fails at baseline passes on the branch.

```text
acquisition-personnel/acquisition-personnel-read.service.spec.ts
acquisition-personnel/extractors/sam-personnel-extractor.spec.ts
acquisition-personnel/org-import/dow-org-import.helpers.spec.ts
engagement/engagement-batch-error-status.spec.ts
engagement/engagement-batch-group.spec.ts
engagement/engagement-batch-revise.spec.ts
engagement/engagement-batch-sticky-provider.spec.ts
meri/meri-tools.firmdata.spec.ts
program-element/extractors/bill-pe-extractor.spec.ts
program-element/program-element-read.service.spec.ts
program-element/program-element-read-provisions.spec.ts
test/e2e/defense-budget-intelligence.e2e.spec.ts
```

That is the documented pre-existing baseline — ~40 failures across 12 suites,
DB-backed and integration specs that need a live Postgres. `legiwatch-ci.yml`'s own
header records the same figure. **None of the 12 is in this feature's area**;
`apps/api` has no funding-opportunities, intelligence, district-nexus or prisma
suite among them.

The `+7` suites are exactly this branch's seven new api spec files
(`funding-opportunities.boundaries`, `funding-opportunities.service`,
`opportunity-kind`, `sam-opportunity-relevance`, `contractor-identity`,
`generate-sam-opportunity-candidates`, `backfill-sam-opportunity-fields`). The
`+241` tests are those plus the additions to the two modified specs
(`grant-opportunity-relevance`, `entity-resolution.service`).

### `apps/web`

| | Baseline `57a8a5b2` | Branch `3e87f8f1` | Delta |
| --- | --- | --- | --- |
| Files failed | 0 | 0 | **0** |
| Files total | 157 | 161 | +4 |
| Tests failed | 0 | 0 | **0** |
| Tests passed | 1376 | 1436 | +60 |
| Exit code | 0 | **0** | — |

`apps/web` is **fully green on both sides** — no pre-existing failures to reason
around. The `+4` files are exactly this branch's four new web specs, and the `+60`
tests are 31 (`FundingOpportunitiesPage`) + 11 (`FundingOpportunitiesSection`) +
12 (`IntelligenceMappingsPage`) + 6 (`App.funding-opportunities-nav`).

One incidental correction: `legiwatch-ci.yml`'s header records "1 in `apps/web`"
among the repo's pre-existing failures. Measured at `57a8a5b2`, that is stale —
`apps/web` had zero. Not touched here; noted because that header is the document
people cite for baseline figures.

### Verdict on the comparison

Zero new failures in either app. Every failure on the branch also fails at the
same `main` SHA, and no baseline failure was masked or accidentally "fixed". The
branch adds 7 api suites and 4 web files, 301 passing tests in total, and breaks
nothing.

---

## What the tests actually prove

Mapping §20's Definition of Done onto assertions that exist and pass, rather than
onto code that looks right:

| Definition-of-Done claim | Assertion |
| --- | --- |
| Grants discoverable with no nightly candidate row | service spec, `grant + contract discovery works with NO producer candidate rows` — three cases, including one that surfaces a grant from award history alone with zero workflow rows |
| SAM contract opportunities visible | same block, `a client with matching NAICS sees the contract opportunity with no workflow row anywhere` |
| Client profile card always renders | section spec, `it renders at ZERO matches, with an explanation` |
| Exact UEI supported, fuzzy names review-only | `contractor-identity.spec.ts` (24 tests) incl. 6 ambiguity cases; fuzzy can never auto-confirm |
| Workflow state durable and tenant-scoped | service spec `workflow persistence` (9 tests) + `tenant safety` (5 tests) |
| Producer reruns preserve human decisions | producer spec, parameterised over all five human statuses, incl. one where the score collapses |
| Relevance separate from eligibility | both relevance specs plus the eligibility states |
| Unknown money never zero | service spec `unknown money is null, never zero` (3 tests) + web `renders "Not stated", never $0` |
| No blended amount | boundaries spec `there is no generic totalAmount anywhere in the types`; web spec asserts no `$` in the KPI strip |
| Future opportunities do not create District Nexus | boundaries spec (no DN file reads the workflow model; the DN scorer's opportunity-only suppression is still a zero multiplier) + service spec `a future opportunity never fabricates a district` |
| Migration, RLS and tenant-scope guards pass | boundaries spec `migration: RLS, uniqueness, check constraints` — 11 assertions incl. RLS ENABLED **and** FORCED, 4 tenant-predicated policies, both partial unique indexes, additive-only, retry-safe, sorts after every existing migration; plus `migration-table-names` and the tenant-scope guard suites |
| Role matrix | boundaries spec builds `new RolesGuard(new Reflector())` and reads real `ROLES_KEY` metadata; `client_portal_user` denied by rank |
| Failed source read never renders as empty | service spec (throws) + web spec (error branch) |

---

## What was NOT verified, and why

Named individually so none of it reads as covered.

| §17 item | Status | Why |
| --- | --- | --- |
| Browser smoke | **NOT RUN** | The branch is not deployed and the `funding_opportunities` flag is off for every tenant, including capiro-internal. §17 forbids claiming a live browser test on an undeployed branch. A local dev server would need the migration applied to a live database, which is out of scope for this PR |
| Narrow viewport | **NOT RUN** | Same reason. No responsive assertion exists either — component tests render at jsdom's default size. This is unmeasured, not passing. It is step 15.12 of the runbook |
| Keyboard navigation | **PARTIAL** | Every filter control has an asserted accessible name, which is a precondition for keyboard use, not proof of it. No focus-order or tab-traversal walk was performed; that is step 15.13 of the runbook |
| Request-failure states | **COVERED** | Asserted in tests, both rails: API throws rather than returning empty, web renders an error branch. Three specs |
| Migration applied to a **live** database | **NOT RUN** | Forbidden by the safety boundaries. RB-1 |
| Migration applied to **any** database | **DONE, in CI** | `engagement-trust-boundary.yml` ran `prisma migrate deploy` against a clean Postgres service container on this branch and logged `Applying migration 20260810010000_funding_opportunities` followed by `All migrations have been successfully applied.` — 187 migrations, check **passed** in 3m37s. So the migration is no longer only statically verified: it is known to apply, in order, to an empty database. That is not the same as applying to *production*, which has data and is still RB-1 |
| Producer runs against real data | **NOT RUN** | Forbidden. Dry-run commands are in the runbook, unexecuted |
| Repo-wide lint | **NOT RUNNABLE** | `pnpm lint` is non-functional repo-wide (eslint is not installed); CI substitutes `prettier --check` scoped to MeriV2 + shared, which this branch does not touch. Documented in `ci-pr.yml`'s own header |
| CI on the branch | **GREEN** | All three checks pass: `verify` (ci-pr) 5m32s, `legiwatch` 6m2s, `engagement` 3m37s. Read the next section for what that does and does not cover |

### What CI checked, and what a green PR does not mean

All three checks are **green on this branch**, first measured on `50970a06` — the
commit that carries the complete implementation. Later commits here are
documentation only, and every push re-runs all three, so the SHA is deliberately
not pinned in this sentence: the code those checks validated does not change.

Worth spelling out what they cover, because it is a
narrower claim than it looks — and note the repo has **no enforced required
checks** (branch protection is unavailable on this plan), so green CI is evidence,
not a gate:

- `ci-pr.yml` (every PR) — `pnpm audit` (advisory, `|| true`), prisma generate,
  prettier on MeriV2 + shared, a BYOK guard, `pnpm turbo run typecheck`, and the
  `meriv2-core` / `meriv2-orchestrator` / `auth` / `api-strategy` suites. It
  **never runs the `apps/api` or `apps/web` suites** — which is why 40
  pre-existing api failures do not make it red, and why the local full-suite
  comparison above is the only branch-versus-baseline evidence that exists.
- `legiwatch-ci.yml` (every PR, deliberately not path-filtered) — zero failures
  and zero skips inside an enumerated LegiWatch scope, with minimum suite/test
  floors. This branch touches no file in that scope.
- `engagement-trust-boundary.yml` (every PR) — applies migrations to a real
  Postgres service container. This is the gate that turned `main` red when #651
  shipped `ALTER TABLE "client"` against a table actually mapped as `clients`, so
  it is the one that matters most here, and it is the only check that touches a
  database at all. It **passed**, having applied all 187 migrations including
  `20260810010000_funding_opportunities`. The prerequisites this migration needs —
  the `uuid-ossp` extension, `rls_bypass()` and `current_tenant_id()` — are all
  created by `20260501000000_init_identity_tenancy`, and 42 existing migrations
  already call `uuid_generate_v4()`.

What green CI therefore does **not** establish: that any `apps/api` or `apps/web`
suite passes (neither is run by any check outside LegiWatch's enumerated scope),
that the feature behaves correctly against real data, or that the migration
applies cleanly to a database **that already has rows**. The first is covered by
the local full-suite comparison above; the other two are not covered anywhere yet.

---

## Merge blockers still open

| # | Blocker | State |
| --- | --- | --- |
| MB-1 | `verification.md` says `Overall: PASS` | **RESOLVED** — this file |
| MB-2 | CI green on the branch | **RESOLVED** — `verify`, `legiwatch` and `engagement` all pass on `50970a06`. See the CI section for the narrower claim that represents |
| MB-3 | Branch behind `main` | **RESOLVED** — 0 behind `57a8a5b2` |
| MB-4 | Temporary CI source-packaging step removed | **RESOLVED** — `git diff origin/main -- .github/workflows/ci-pr.yml` is empty, so the step and the comment corruption the scaffold commit introduced are both gone |
| MB-5 | Manual browser walk of the new surface | **OPEN** — see "What was NOT verified". Component tests are not a substitute |
| MB-6 | Four card actions have API support but no UI modal (assign owner, add note, link project site, create task) | **OPEN** — §11 row is PARTIAL, not DONE |

`Overall: PASS` is a statement about the verification commands. MB-5 and MB-6 are
why this PR is still a draft.
