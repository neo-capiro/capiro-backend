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

---

# EXECUTION RESULT — phases a–i complete

Branch `feat/clerk-auth-hardening` off `main` @ `913932e7`. 9 commits, 87 files,
+4369/-530. **Not merged, not deployed.**

## Final regression — measured, zero new failures

| Package | Baseline (pre-change) | Final | Delta |
|---|---|---|---|
| `@capiro/auth` | 10 passed | **20 passed** | +10 |
| `@capiro/api-strategy` | 1078 passed | 1078 passed | — |
| `@capiro/meriv2-orchestrator` | 235 passed | 235 passed | — |
| `@capiro/onboard-api` | 60 passed | 60 passed | — |
| `@capiro/api` | 40 failed / 3986 passed | **40 failed** / 4051 passed | +65 passing |
| `@capiro/intel-api` | 58 failed / 405 passed | **58 failed** / 427 passed | +22 passing |
| `@capiro/workspace` | 1 failed / 81 passed | **1 failed** / 83 passed | +2 passing |
| `@capiro/web` | 1 failed / 637 passed | **1 failed** / 637 passed | — |
| `@capiro/onboard-web` | no tests | **23 passed** | +23 |

Typecheck: **18/18**. Failing sets verified byte-identical to baseline.
**+122 net new passing tests. Zero new failures.**

## OPEN ITEMS

### Blocked on AWS (authored + committed, NOT applied)
1. **3 migrations not applied.** `20260802010000_identity_outbox` (apps/api),
   `20260802020000_intel_ws_ticket` (intel-api), `20260802030000_user_identity_conflict`
   (apps/api). Run the `capiro-<env>-api-migrate` / `-intel-api-migrate` task
   families BEFORE the corresponding service rolls. CI does not run migrations.
2. **`capiro-dev-intel-api` task def needs `CLERK_JWT_ISSUER`, `WEB_ORIGIN`,
   `NODE_ENV`.** Until then intel-api pins no issuer AND
   **`http://localhost:5173` remains in its PRODUCTION HTTP CORS allowlist**
   (main.ts fallback). The new WS origin gate is unaffected — it never reads
   WEB_ORIGIN — but the HTTP hole is real and live today.
3. **Phase-h rollout ordering is strict:** migrate → MeriV2 (accept the service
   secret) → intel-api (dual-accept) → web (ticket) → follow-up commit removing
   the legacy query-string branch and `extractToken`'s `?authorization`/`?token`
   handling. Shipping web before intel-api breaks live hearings.
4. **`packages/auth` consumers must be rebuilt manually.** Only
   `api-strategy-image.yml` and `onboard-api-image.yml` include `packages/auth/**`
   in their path filters — **workspace and meriv2-orchestrator will NOT rebuild**
   and would silently run the old auth code.
5. **CloudWatch metric filters + alarms** are committed to CDK but must be applied
   with `aws logs put-metric-filter` / `put-metric-alarm`. **Do NOT
   `cdk deploy Capiro-dev-Compute`** (2026-07-25 DNS revert incident).
6. **Outbox drain is not scheduled.** The `drain-identity-outbox` verb exists but
   nothing invokes it periodically; wire an EventBridge rule to `ecs run-task`.

### Needs a decision
7. **Phase j (`authorizedParties`) is BLOCKED.** Enable `CLERK_LOG_AZP=true`,
   collect distinct `azp` values for ~7 days, then set the allowlist to exactly
   that observed set. **If every value is `ABSENT`, CANCEL phase j** rather than
   ship it — a control that protects nothing reads as coverage.
8. **Identity-rebind BLOCKING gate not implemented** (deliberate). Finding #5 is
   currently record-only: the three paths emit `identity.rebind`/`identity.merge`
   and two write a `UserIdentityConflict` row. Blocking requires knowing how often
   the email-rebind legitimately fires — `pending_invite` has zero producers, so a
   naive gate degrades to "never rebind" and breaks the self-heal path. Review the
   ledger, then decide.
9. **Pre-merge DB check not run:** `SELECT id, slug FROM tenants WHERE clerk_org_id IS NULL;`
   The guard is written to tolerate NULL (the org cross-check is conditional and
   `capiro_tenant_id` is the fallback), so this is confirmation, not a blocker.

### Out of scope, logged
10. No WebSocket heartbeat and no client reconnect. Live ALB idle timeout is
    **4000s (~66 min)**, not the 300s in `compute-stack.ts:1535`, so a hearing quiet
    for over an hour is culled with no recovery.
11. Pre-existing spec drift left alone: workspace `cascade` (catalogue has 11
    products, spec expects 10), `engine-api.int-spec` / `steering-memories` (TS2554
    arity), `pe-resolver`.
12. `CAPIRO_INTERNAL_SLUG` is still duplicated in apps/api and onboard-api.
13. Live `WEB_ORIGIN` drift on `capiro-dev-api`: two hosts (`app-dev.capiro.ai`,
    `acmelobby.app-dev.capiro.ai`) exist live but appear nowhere in the repo.

---

# CLOSE-OUT — 2026-07-26

## Shipped to production

`main` @ `f02a40cb` (#573) + `dc80445b` (#579) + `3b595ed0` (#580); #582 pending.
All 7 ECS services rolled and verified HEALTHY on new code.

### Live-verified fixes (not just deployed — observed working)

| Fix | Evidence |
|---|---|
| localhost out of production CORS | curl: `http://localhost:5173` → rejected; `app.capiro.ai` → allowed |
| SMS OTP no longer returned in API responses | `NODE_ENV=production` now set on capiro-dev-intel-api |
| WS origin gate | disallowed origin → **401 before the 101 upgrade**; no-Origin → 401 |
| WS ticket rejection | bogus ticket → `{"security_event":"auth.denied","reason":"ws_ticket_invalid","surface":"ws"}` |
| ws-ticket endpoint | 401 unauthenticated (vs 404 for a nonexistent route → proves registration) |
| Membership enforcement | 0 tenants with NULL clerk_org_id; the 1 removed membership is a tombstoned identity, so **0 live users denied** |
| Migrations | all 3 tables exist with RLS **enabled + forced**; `_prisma_migrations` all finished |
| Outbox drain | exit 0, `{"event":"identity_outbox.drain","processed":0,...}` |

### Monitoring live
- 4 metric filters, namespace `Capiro/Security`, on `/capiro/dev/api`,
  `/capiro/dev/api-strategy`, `/capiro/dev/onboard-api`.
- Alarm `capiro-dev-identity-deprovision-failed` → SNS `capiro-dev-platform-alarms`.
- EventBridge `capiro-dev-drain-identity-outbox`, `rate(15 minutes)`, **ENABLED**
  (only after a manual run exited 0 — it was disabled through two failed attempts).

## Two bugs I shipped and had to fix

`drain-identity-outbox` failed **twice** in production before working:
1. `createApplicationContext(AppModule)` → crashed in `InsightGeneratorService`.
2. A minimal Nest module → `ConfigService` undefined in `ClerkService`.

Fixed by dropping Nest entirely and constructing the collaborators by hand,
matching the 127 scripts that already do that.

**ROOT CAUSE, worth fixing separately: `apps/api/tsconfig.json` excludes
`scripts/`, so `turbo run typecheck` never checks ANY file in that directory.**
Both bugs were invisible to CI. Any script change must be typechecked
explicitly.

## Remaining

| Item | Status |
|---|---|
| PR #582 (WS dual-accept removal) | open, CI pending |
| Live hearing smoke test | **needs a human** — mint→consume→Deepgram unproven with real audio |
| Phase j (`authorizedParties`) | NOT shipped. Needs `CLERK_LOG_AZP=true` + ~7 days. **Cancel if `azp` is always ABSENT** |
| Identity-rebind blocking gate | record-only by design; revisit once `user_identity_conflict` has rows |
| WS heartbeat / reconnect | out of scope; ALB idle timeout is 4000s with no heartbeat |
