# Clerk Auth Hardening — Verified Test Baseline

**Branch:** `feat/clerk-auth-hardening`, cut from `main` @ `913932e7`.
**Measured:** 2026-07-25, after phase-a tasks a3 (`@jest/globals` + `#crypto` mapping) and a4 (vitest env).
**Purpose:** every later phase diffs its regression check against THIS table, never against zero.

Plan: `C:\Users\neoma\Downloads\clerk-auth-hardening-plan-2026-07-25.md`.

---

## Gate 1 — typecheck

```
pnpm turbo run typecheck --force --continue
```
**Result: `Tasks: 18 successful, 18 total`, exit 0.**

> `--force --continue` is mandatory. The `.turbo` cache replays *stale* failures citing
> code that no longer exists in the file. Never measure a gate off a cached run.

## Gate 2 — format (CI parity) — ⚠️ ALREADY RED ON MAIN

```
pnpm exec prettier --check "packages/meriv2-core/**/*.ts" "apps/meriv2-orchestrator/**/*.ts" "packages/shared/**/*.ts"
```
**Result: `Code style issues found in 133 files.`**

**This fails on CLEAN `main` @ `913932e7`, before any change in this branch.** Proved by
stashing all phase-a edits and re-running: identical 133-file failure. The plan asserted this
was a working blocking gate — **that was wrong**, and it is corrected here.

Consequences for later phases:
- **Gate 2 cannot be used as a pass/fail regression gate.** The practical criterion is instead:
  *files newly created by this work must be prettier-clean, and files edited must not get worse.*
- **`packages/shared/src/index.ts` is one of the 133** and phase b1 must edit it.
  **Do NOT run `prettier --write` on it** — that would bury the security diff in hundreds of
  unrelated reformatting lines. Match the surrounding style by hand.
- The version is not the cause: the lockfile's prettier resolution is byte-identical
  before and after `pnpm install` (`git diff pnpm-lock.yaml | grep -i prettier` → empty).

> `pnpm turbo run lint` is DEAD repo-wide — eslint is not installed and there is no
> config file. Do not use it as a gate either.

### Incidental lockfile churn (accepted, not intended)
`pnpm install` re-resolved `ts-jest`'s peer key, dropping `ts-node` from the
`jest@29.7.0(...)` peer chain in ~9 places. This is pnpm normalizing pre-existing lockfile
drift, not a dependency change: no package version moved, and all 9 packages' suites were
re-run afterwards with no new failures. Logged for transparency.

---

## Gate 3 — per-package test baseline

| Package | Suites | Tests |
|---|---|---|
| `@capiro/auth` | **1 passed / 1** | **10 passed / 10** — GREEN |
| `@capiro/api-strategy` | 51 passed, 3 skipped / 54 | 1078 passed, 11 skipped / 1089 — GREEN |
| `@capiro/meriv2-orchestrator` | **23 passed / 23** | 235 passed, 2 skipped / 237 — GREEN |
| `@capiro/onboard-api` | **6 passed / 6** | **60 passed / 60** — GREEN |
| `@capiro/api` | **12 failed**, 379 passed / 391 | **40 failed**, 1 todo, 3986 passed / 4027 |
| `@capiro/intel-api` | **12 failed**, 40 passed / 52 | **58 failed**, 405 passed / 463 |
| `@capiro/workspace` | **4 failed**, 10 passed / 14 | **1 failed**, 81 passed / 82 |
| `@capiro/web` | **1 failed**, 93 passed / 94 | **1 failed**, 637 passed / 638 |
| `@capiro/onboard-web` | no test files | `--passWithNoTests` — can never fail |

Commands:
```
pnpm --filter @capiro/auth test
pnpm --filter @capiro/api-strategy test
pnpm --filter @capiro/meriv2-orchestrator test
pnpm --filter @capiro/onboard-api test
pnpm --filter @capiro/intel-api test
pnpm --filter @capiro/workspace test
pnpm --filter @capiro/web test
pnpm --filter @capiro/api test
```
Single-file targeting: `pnpm --filter @capiro/api test src/tenant/tenant-context.middleware.spec.ts`.

---

## Pre-existing failures — NOT regressions

### `@capiro/api` — 12 suites / 40 tests. None auth-, tenant- or Clerk-related.
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
Cause: drifted hand-built Prisma mocks missing delegates the service now calls.

### `@capiro/intel-api` — 12 suites / 58 tests. Stale mocks, not DB-absence skips.
```
test/bill-hearing-linker.spec.ts   test/bill-hearings.spec.ts
test/feature-flag.spec.ts          test/feed.spec.ts
test/hearing-brief.spec.ts         test/hearing-consent.spec.ts
test/orchestrator-client.spec.ts   test/seed-suggestions.spec.ts
test/sms-verification.spec.ts      test/tracker-summary.spec.ts
test/tracker-watchlist.spec.ts     test/watchlist-match-promoter.spec.ts
```
**Two are auth-adjacent and RED BEFORE ANY CHANGE** — `feature-flag.spec.ts`
(`TypeError: this.prisma.withTenant is not a function`) and `orchestrator-client.spec.ts`
(`TypeError: Cannot read properties of undefined (reading 'resolve')`, stale 1-arg
constructor). **Phase h modifies `orchestrator-client`'s subject — diff against this
list, not against green.**

### `@capiro/workspace` — 4 suites / 1 test. Spec-vs-service drift, none auth-related.
| Suite | Cause |
|---|---|
| `test/cascade.spec.ts` | asserts 10 canonical products; catalogue now has **11**. Real assertion failure, newly *visible* (previously masked by the compile error) |
| `test/engine-api.int-spec.ts` | `TS2554` arity drift at `:43,:44,:45` |
| `test/pe-resolver.spec.ts` | suite fails to run |
| `test/steering-memories.spec.ts` | `TS2554: Expected 7 arguments, but got 6` at `:142`, `:216` |

### `@capiro/web` — 1 test.
`src/pages/program-element/ProgramElementWatchPage.test.tsx > renders the hero, KPI strip,
and tabbed panels` — `TypeError: Cannot read properties of undefined (reading 'length')` at
`src/pages/program-element/FundingNarrativePanel.tsx:31`.

---

## What phase a changed, and the before/after it produced

| Task | Change | Effect |
|---|---|---|
| **a1** | Branched `feat/clerk-auth-hardening` off `main` @ `913932e7` | Plan assumed 4 dirty intel-api files needing a stash; they had since been committed to `feat/legiwatch-hardening`. Tree was clean — **no stash performed** |
| **a3** | `apps/workspace/package.json`: added `@jest/globals@^29.7.0` | Fixed `TS2307` in 6 suites |
| **a3** | `apps/workspace/test/tenant-guard.spec.ts:27`: `jest.Mock<R, [Args]>` → `jest.Mock<(a) => R>` | `@jest/globals`' `jest.Mock` takes ONE function-type arg; `@types/jest`' takes two. Not anticipated by the plan |
| **a3** | `apps/workspace/jest.config.cjs`: `#crypto` bare specifier → absolute path via `require.resolve('@clerk/backend/package.json')` | The deep specifier is refused by the package `exports` map even though the file exists. **Not anticipated by the plan** — without it `tenant-guard.spec.ts` still could not run |
| **a4** | `apps/web/vitest.config.ts`: `env: { VITE_CLERK_PUBLISHABLE_KEY: 'pk_test_dummy' }` | `App.auth-gate.test.tsx` + `api-client.test.ts` now collect (5 tests) |

**Workspace: 7 failed suites / 62 passing tests → 4 failed suites / 81 passing tests.**
**`test/tenant-guard.spec.ts` now PASSES 6/6** — it is the file phase g10 must rewrite, and
it was unrunnable before this phase.

---

## Standing environment gotchas

- **`@jest/globals` is a devDep of only `api`, `api-strategy`, and (now) `workspace`.** New specs
  in `intel-api` / `onboard-api` / `meriv2-orchestrator` / `auth` must use **ambient** jest globals.
- **`apps/*/test/**` is never typechecked** — all six Nest tsconfigs exclude it, and
  `packages/auth/tsconfig.json` excludes `**/*.spec.ts`. Prefer colocated `src/**/*.spec.ts`.
- **`#crypto` mapping** now uses the absolute-path pattern in `api` and `workspace`.
  `intel-api` and `onboard-api` still use the fragile bare specifier — fix if a spec there
  ever pulls in `@clerk/backend`.
- Aurora is private-subnet: **no local DB connection**. DB-backed verification runs via
  `ecs run-task` only.
