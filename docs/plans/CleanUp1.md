# CleanUp1 — Test foundation and auth-free Playwright visual baselines

**Status:** not started
**Depends on:** nothing. First plan; precondition for CleanUp2 and CleanUp3.
**Gate:** `pnpm gate:cleanup1` green from a clean checkout — every unit suite, every UI/visual test and every guard passes, with no test deleted or skipped to get there.
**Feeds:** CleanUp2 (duplicate code removal), CleanUp3 (duplicate test removal), CleanUp4 (architecture: data-driven registries, shared seams, twin/God decomposition — see `docs/plans/CleanUp4.md`).

---

## 1. Why this plan exists

Two later gates are phrased as *"the UI tests perform exactly the same as before"*. That sentence is currently unverifiable:

1. **Nothing compares screenshots.** `apps/web/scripts/vnext-visual-capture.mjs` drives Chrome over CDP, writes PNGs plus a SHA-256 `manifest.json`, and `.github/workflows/web-vnext-foundation.yml` uploads the directory as a CI artifact. It never diffs against anything. `apps/web/src/vnext/testing/visual/README.md` states this itself: *"A capture harness is not equivalent to a passing visual regression"* and *"the manifest hashes are the evidence trail"*.
2. **Those captures are not kept.** `.gitignore` ignores `apps/web/artifacts/vnext-visual/` and `apps/web/artifacts/hillday-visual/`. CI artifacts expire. There is no stored "before" to compare an "after" to.
3. **There is no code coverage anywhere** — no `--coverage` in any `test` script, no `coverageThreshold` in the repo, no coverage artifact.
4. **The main PR gate does not run the `apps/api` suite.** `ci-pr.yml` typechecks everything including api spec files, then runs jest only for a handful of packages; it carries a standing *"Follow-up: add an apps/api jest step"* comment. The full api suite runs in exactly one workflow.
5. **Three of four architecture guards have never run** (`check-evaluation-`, `check-learning-signal-`, `check-quality-telemetry-new-bypasses.mjs` are referenced by nothing).
6. **A whole app is untested by CI** — `apps/defense-budget-parser` (Python, 283 pytest functions) is referenced by no workflow, and its `pytest-cov` devDependency is never invoked.

This plan changes **no product behaviour**. No file under any `src/` is refactored. Tests, harnesses and CI are added; coverage is measured.

---

## 2. Evidence is a snapshot — re-validation protocol

> **Read this before using any number in this plan.**

Every count below was measured against commit **`67bab09`**, which is the commit all `graphify-out/*/graph.json` files record as `built_at_commit`, with a clean working tree. That is a *snapshot of expectation*, not a fact about the day you execute.

This is a multi-user workspace. Files will have been edited, added and deleted by other people before this plan runs. Therefore:

**R1 — Re-derive before you act.** Step 0 of every workstream is a discovery command that regenerates the numbers. If a number below disagrees with the current tree, the current tree wins.

**R2 — Anchor on identities, not positions.** The machine key for every duplicate is `(symbol name, source_file)`, never a line number. Line numbers move under edit and were already stale the moment this document was written, so none of the target lists below contain one; never search for one.

**R3 — Counts are expectations with tolerance.** Recorded counts (tests, routes, spec files) are compared as `current vs expected` and reconciled. A difference of a few percent needs an explanation, not a re-plan. A difference of >10% means someone did work in this area: stop and re-scope.

**R4 — A missing anchor is "already done", not "error".** If a target file, symbol, route or guard named here no longer exists, record it as `obsolete` with the commit that removed it and move on. Never recreate something to satisfy a plan.

**R5 — Never resolve a conflict by reverting another author.** If a target changed underneath you, re-read it and re-run the affected verification. Conflict resolution via `git checkout --theirs` / wholesale revert is forbidden inside this plan.

**R6 — The graph is a snapshot; the source is truth.** The `graphify-out/*/graph.json` files are inputs to the inventory scripts, so a stale graph silently reproduces stale findings. Re-run `.graphify_subjects.py --build all` (or at minimum `--update`) before any workstream that depends on graph-derived lists. If the graph cannot be rebuilt, the source-level discovery commands in this plan still work — use those.

**R7 — Guard against silent scope loss.** If a package, app or runner named here has been renamed, split or removed, note it in the plan's evidence file and state explicitly whether it is in or out of scope. Do not let it drop out by omission.

**R8 — Claim your scope.** Before a workstream, append a `claimed_by / started_at` line to `docs/plans/cleanup1-progress.md`. On a shared workspace two people must not both rewrite `ci-pr.yml`.

### Step 0 — discovery (run this first, always)

```bash
git rev-parse HEAD                                  # record as RUN_SHA
git status --porcelain                              # expect only this plan's own new files
pnpm install --frozen-lockfile
pnpm turbo run test 2>&1 | tee /tmp/cleanup1-baseline.log
```

Then re-derive, and write the results into `docs/plans/cleanup1-baseline.md`:

```bash
# test-case counts per runner (see §5.4 for the same dumps used as the CleanUp3 harness)
pnpm --filter @capiro/api  exec jest --json --outputFile=/tmp/api-names.json
pnpm --filter @capiro/web  exec vitest run --reporter=json --outputFile=/tmp/web-names.json
pnpm --filter @capiro/workspace exec jest --json --outputFile=/tmp/workspace-names.json
cd apps/defense-budget-parser && uv run pytest --collect-only -q > /tmp/py-names.txt

# route inventory (drives the visual baseline set — regenerate, never copy a stale list)
grep -o 'path="[^"]*"' apps/web/src/App.tsx | sort -u

# packages that actually define a test script
for d in apps/* packages/* infra/*; do
  [ -f "$d/package.json" ] && node -e "const p=require('./$d/package.json');
    if(p.scripts&&p.scripts.test) console.log(p.name+' -> '+p.scripts.test)" 2>/dev/null
done
```

---

## 3. Baseline expectations at `67bab09`

> **Re-validated at `c816b240c` (984 commits later).** The file counts in this section have been
> refreshed (spec files, routes, mirror size, script count). The **test-case** counts (`16,747` / `5,124`
> / `42,320`) are still the `67bab09` figures and were not re-run; re-derive them with the §2 Step 0
> commands before relying on them.

Treat as expectations (§2 R3), not assertions.

| Surface | Files | Tests | Runner | In CI today? |
|---|---:|---:|---|---|
| `apps/api` | 1,793 spec files | 16,747 `it`/`test`, 42,320 `expect` | jest (hermetic tier) | full suite in 1 workflow only |
| `apps/web` | 648 test files | 5,124 | vitest + jsdom | 1 workflow only |
| `apps/workspace` | 45 test files | — | jest | partial |
| `apps/onboard-web` | 1 test file | — | vitest | no |
| `apps/api-strategy` | — | — | jest | yes (`ci-pr.yml`) |
| `apps/intel-api` | — | — | jest | per-workflow slices |
| `apps/onboard-api` | — | — | jest | per-workflow slices |
| `apps/defense-api` | — | — | `tsx --test` (node:test) | **no** |
| `apps/meriv2-orchestrator` | — | — | jest | yes |
| `apps/meriv2-core` | — | — | jest | yes |
| `packages/auth` | — | — | jest | yes |
| `infra/cdk` | — | — | jest + constructs | yes |
| `apps/defense-budget-parser` | 50 `.py`, 12,653 lines | 283 pytest functions (13 files) | pytest + uv | **no workflow references it** |

Other expectations:

* `apps/api` codebase: 4,089 `.ts` / 1,099,462 lines; 33 `.py` / 6,572 lines.
* `apps/web/src/App.tsx` declares **72** routes.
* `apps/web/scripts/` holds **20** CDP browser scripts; **10** carry their own `chrome-launcher` + CDP client; only **2** import the shared `phase19-cdp.mjs`.
* 35 of 39 `*.integration.spec.ts` self-skip on a missing env var (`const describeDatabase = databaseUrl ? describe : describe.skip`), so a DB-free `apps/api` run is achievable. **Verify rather than assume** — the standing ci-pr TODO claims much of the suite is DB-backed.
* Untested duplication sites: **40** duplicated `src` files and **146** duplicated `script` files in `apps/api`.
* Environment: pnpm 9.12.0, `engines.node >= 20.11`.
* Four bypass guards exist; only `check-context-plane-new-bypasses.mjs` is wired.
* **The duplication ledger is now complete across all eight code subjects** (`docs/plans/cleanup2-dup-inventory.generated.md`): 1,559 groups / 20,856 wasted lines at `67bab09`, of which 1,071 groups / 12,266 lines are production. `02-web` is the largest subject.
* **`apps/defense-api/runtime-source/**` is a deliberate byte-identical mirror** of parts of `apps/api`, enforced by `scripts/verify-phase8-session4.mjs` (git tree-SHA equality) in 8 workflows. 378 mirrored `.ts` files verified identical at `67bab09` (**730** at re-verification `c816b240c`). Any edit inside a mirrored tree must land on both sides in the same commit.

---

## 4. Interpretation decisions (correct these if wrong)

* **"UI tests"** = Playwright specs over `apps/web` (70 routes) at three viewports, plus a smoke spec each for `apps/workspace` and `apps/onboard-web`. The 20 existing CDP scripts are *not* UI tests here; they are ad-hoc capture/acceptance tooling, handled as an explicit workstream in CleanUp2 §6.
* **"Baseline screenshot"** = a PNG committed to git plus a `baseline-manifest.json` (sha256, route, viewport, capturing SHA). §8.3 explains the deliberate deviation from the gitignored `artifacts/` convention.
* **Baseline-for-regression ≠ baseline-for-Figma-parity.** `apps/web/src/vnext/testing/visual/README.md` sets a rule for *parity* claims: only add a screenshot baseline once a screen is implemented from its canonical Figma node. That rule governs Figma overlays. This plan creates *regression* baselines, whose only claim is "renders the same as before" — an existing screen qualifies regardless of its Figma provenance. State this distinction in the baseline manifest so nobody reads the two rules as contradictory.
* **Coverage is measured, not enforced.** A number is recorded. Thresholds appear only in CleanUp3, as a must-not-go-down check.
* **Already-red tests are quarantined, not fixed.** Each gets an owner and expiry in `docs/plans/cleanup1-quarantine.md`. This plan must not absorb product bugs.

---

## 5. Workstream 1 — Make every suite runnable and measurable

### 5.1 Record the starting point

Write `docs/plans/cleanup1-baseline.md`: `RUN_SHA`, per-package pass/fail counts, every pre-existing failure, and any package from §3 that no longer exists (§2 R7).

### 5.2 Enable coverage (no thresholds)

Add alongside the existing `test` script in each package. Skip any package that no longer exists.

| Package | New script |
|---|---|
| `apps/api` | `"test:coverage": "jest --coverage --coverageReporters=json-summary,text"` |
| `apps/web` | `"test:coverage": "vitest run --coverage"` (+ `@vitest/coverage-v8`) |
| `apps/workspace` | `"test:coverage": "jest --coverage --coverageReporters=json-summary,text"` |
| `apps/onboard-web` | `"test:coverage": "vitest run --coverage"` |
| `apps/defense-budget-parser` | `uv run pytest --cov=capiro_defense_budget_parser --cov-report=json` |

Commit summaries to `docs/plans/cleanup1-coverage-baseline.json`. Do **not** add `coverageThreshold`, `--cov-fail-under`, or any gate.

### 5.3 Close the CI gaps

1. **Add an `apps/api` jest step to `.github/workflows/ci-pr.yml`.** Retires the standing TODO. Confirm DB-free green first (see §3); if it genuinely needs Postgres, add a `postgres:16` service rather than leaving the hole.
2. **Add an `apps/web` vitest step** so 5,124 web tests do not depend on one unrelated workflow.
3. **Add a `apps/defense-api` (`tsx --test`) step.**
4. **Wire the three dormant guards** exactly as `context-plane-architecture-guard.yml` does: `check-evaluation-`, `check-learning-signal-`, `check-quality-telemetry-new-bypasses.mjs`.
5. **Do not hand-maintain a package list.** Prefer `pnpm turbo run test`, which picks up new packages automatically, so a rename or addition in another author's PR cannot silently drop a suite (§2 R7).

**CI hygiene for a shared workspace:** make these new steps run on pull requests from the same trigger conditions as the existing ones, and do not tighten unrelated triggers in the same PR — a widened `paths:` filter blocks other people's merges.

---

## 6. Workstream 2 — Unit tests for the sites CleanUp2 will change

Purpose: supply the safety net exactly where it is missing. **Do not** write tests for byte-identical helper duplicates — their equivalence is proven by fingerprint, and a test per copy becomes the duplication CleanUp3 must remove.

### 6.1 Derive the list, don't trust the one below

```bash
# regenerate the full ledger first, then read its no-test sites for every subject
.graphify-venv/Scripts/python.exe .graphify_ledger.py
.graphify-venv/Scripts/python.exe .graphify_dedup_readiness.py 01-api | sed -n '/no test at all/,$p'
```

The ledger now covers `apps/web`, `apps/workspace`, `apps/onboard-*`, the root `scripts/`, `packages/*` and the Python parser — not just `apps/api`. §6.2's smoke harness must therefore be generalised: the same no-args-exit-code pattern applies to the root `scripts/*.mjs` family (~180 `.mjs` files in subject `08-platform`) as it does to `apps/api/scripts`.

Expect roughly **40** duplicated `src` files and **146** duplicated `script` files with no test (CleanUp1-era numbers). Highest-copy sites at `67bab09` were `outreach-v3/send/outreach-v3-send.service.ts` (14 copies), `outreach-v3/context/outreach-v3-context.service.ts` (9), `capabilities/targets/get-target-profile.capability.ts` (9), the `external/tango/*` mappers, and the Google/Microsoft OAuth + integration-action controllers. **Paths drift** — re-derive, and if a listed file no longer contains a duplicate (already merged by another author), mark it `obsolete` under §2 R4.

### 6.2 A script smoke harness (covers all scripts at once)

`apps/api/scripts` is the largest duplication cluster and most of its duplicated files have no test. Per-script unit tests are the wrong instrument. Add one harness that, for every script entry point discovered at runtime (glob `apps/api/scripts/**/*.ts`, excluding `lib/`, `__tools__/`, `__data__/` and `*.spec.ts`):

* invokes it with no args (and `--help` where supported) in a child process with `DATABASE_URL` unset;
* asserts the exit code is a documented one, not an unhandled-rejection trace;
* asserts a usage/help line reaches stdout or stderr;
* asserts no DB/network connection is attempted without config;
* asserts termination within a fixed timeout with no open handle.

Use a generated case list (`it.each`) from the glob, not a checked-in list of 628 filenames — that is what makes it survive files being added by other authors.

### 6.3 Python

`apps/defense-budget-parser/tests/` already holds 13 pytest files with 283 test functions; nothing new is required beyond §7. Additional tests for the helpers CleanUp2 Wave 3 merges are written in CleanUp2, next to each merge.

---

## 7. Workstream 3 — The Python parser (`apps/defense-budget-parser`)

Surfaced by analysis, not in the original brief. It is a first-class workstream because it holds **~98% of the repo's Python duplication** and **has never run in CI**.

Facts at `67bab09`: 50 `.py` / 12,653 lines under `src/capiro_defense_budget_parser/` + 13 pytest files under `tests/`; `pyproject.toml` declares `pytest`, `pytest-cov`, `ruff`, `mypy` (strict) and pins Python 3.11 with `uv.lock`. No workflow anywhere references the app.

### 7.1 New workflow `.github/workflows/defense-budget-parser-ci.yml`

Sketch — adapt triggers to the existing house style rather than inventing a new one:

```yaml
on:
  pull_request:
    paths:
      - 'apps/defense-budget-parser/**'
      - '.github/workflows/defense-budget-parser-ci.yml'
jobs:
  test:
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v5
      - uses: actions/setup-python@v5
        with: { python-version: '3.11' }
      - run: uv sync --frozen
        working-directory: apps/defense-budget-parser
      - run: uv run ruff check .
        working-directory: apps/defense-budget-parser
      - run: uv run mypy src
        working-directory: apps/defense-budget-parser
      - run: uv run pytest --cov=capiro_defense_budget_parser --cov-report=json
        working-directory: apps/defense-budget-parser
```

Pin the action major versions to whatever the repo already uses.

### 7.2 Why this belongs in CleanUp1, not CleanUp2

CleanUp2 Wave 3 merges ~573 lines inside this app. Running those 283 tests in CI *before* touching the code is what makes the merge reviewable. Wiring CI after the refactor would gate the change on a suite nobody had ever seen run.

---

## 8. Workstream 4 — Playwright visual baseline harness

### 8.1 Location and package

New workspace package **`apps/e2e`** (`@capiro/e2e`). `pnpm-workspace.yaml` globs `apps/*`, so no workspace change is needed — verify this is still true at execution time (§2 R1).

```bash
pnpm --filter @capiro/e2e exec playwright install --with-deps chromium
```

Chromium only: it matches what the existing CDP harness drives, keeps the two comparable, and keeps CI cost down. Firefox/WebKit can be added later as opt-in projects.

### 8.2 Determinism contract (treat as the spec)

| Concern | Setting |
|---|---|
| Viewport | explicit per project: 1440×1000, 1024×1000, 390×844 |
| DPR / scrollbars | `deviceScaleFactor: 1`, `--force-device-scale-factor=1`, `--hide-scrollbars` |
| Proxy | `--proxy-server=direct://`, `--proxy-bypass-list=*` (a system proxy previously landed the tab on `chrome-error://chromewebdata`) |
| Motion | `reducedMotion: 'reduce'`; `toHaveScreenshot({ animations: 'disabled' })` |
| Locale / time zone | `locale: 'en-US'`, `timezoneId: 'America/New_York'` |
| Clock | `page.clock.setFixedTime(...)` so relative timestamps are stable |
| Fonts | `await page.evaluate(() => document.fonts.ready)`, then two `requestAnimationFrame`s |
| Network | no live calls; intercept everything; reuse `apps/web/src/vnext/testing/visual/{api-fixture.ts,clerk-stub.tsx,auth-fixture.tsx}` and the offline server `apps/web/vite.visual.config.ts` |
| Auth | Clerk stub (offline) for v1; a real-Clerk `storageState` project is a later addition |
| Volatile regions | `mask:` avatars, IDs, timestamps, chart canvases, anything clock- or random-derived |
| Render sentinel | every spec asserts a sentinel selector before screenshotting — a blank PNG must never become a baseline (the existing harness's own rule) |

### 8.3 Baseline storage

```
apps/e2e/baselines/<project>/<route>.png
apps/e2e/baselines/manifest.json     # sha256, route, viewport, capturing SHA, purpose: regression-not-parity
```

Committed to git, deliberately unlike `apps/web/artifacts/`. That directory's `.gitignore` comment reasons that PNGs "do not belong in git history" — correct for a *capture* whose only consumer is a human reading a CI artifact, wrong for a *comparison baseline*, which must be content-addressable, pinned to a commit, and available after CI artifacts expire. The `manifest.json` preserves the repo's existing "the hash is the evidence trail" doctrine, and records the purpose field from §4 so the README's Figma-parity rule is not read as violated.

### 8.4 Route inventory — generated, and self-enforcing

The route list must **not** be copied into a spec file. Generate it:

```bash
grep -o 'path="[^"]*"' apps/web/src/App.tsx | sort -u
```

Then add a **route-coverage guard test**: read `App.tsx` at test time, extract the declared paths, and fail if any declared route has no baseline. That converts "someone added a route and forgot the screenshot" from a silent gap into a red test — which is the whole point of doing this in a multi-user workspace.

Routes added by other authors between now and execution then *fail loudly* rather than going unphotographed.

### 8.5 Comparison policy

```ts
expect(page).toHaveScreenshot('route-name.png', {
  maxDiffPixelRatio: 0.002,
  threshold: 0.2,
  animations: 'disabled',
});
```

`--update-snapshots` is permitted **only** in a dedicated PR stating the product reason and attaching before/after images. A visual diff discovered in CleanUp2 or CleanUp3 is a failure, never a baseline update.

### 8.6 Leave the existing CDP scripts alone

The 10 duplicate CDP clients are a CleanUp2 target. Re-expressing three target families in Playwright does not license removing any script here — that would put behaviour-changing edits inside a plan whose gate is "nothing changed".

---

## 9. Workstream 5 — The gate

Root `package.json`:

```json
"gate:cleanup1": "pnpm turbo run typecheck && pnpm turbo run test && pnpm --filter @capiro/e2e test && node scripts/verify-phase8-session4.mjs && node scripts/check-context-plane-new-bypasses.mjs && node scripts/check-evaluation-new-bypasses.mjs && node scripts/check-learning-signal-new-bypasses.mjs && node scripts/check-quality-telemetry-new-bypasses.mjs",
"gate:cleanup1:python": "cd apps/defense-budget-parser && uv run pytest"
```

`pnpm turbo run test` covers every package that defines a `test` script, so a package added or renamed by another author is picked up automatically instead of being missed from a hand-maintained list (§2 R7). `verify-phase8-session4.mjs` is in the gate because CleanUp2 will edit files inside mirrored trees: `apps/defense-api/runtime-source/**` must stay a byte-identical copy of parts of `apps/api`, enforced by **git tree-SHA equality**, and 176 ledger groups carry that obligation. Without this clause in the gate, a mirror miss is only caught by one of 8 path-filtered workflows. CleanUp2 §3.2 has the detail.

Wire both into CI on pull requests. This is the command CleanUp2 and CleanUp3 must keep green.

---

## 10. Gate criteria

- [ ] §2 Step 0 discovery run recorded, with every divergence from §3 reconciled in writing.
- [ ] `pnpm install --frozen-lockfile && pnpm gate:cleanup1` green from a clean checkout.
- [ ] `pnpm gate:cleanup1:python` green, and `apps/defense-budget-parser` has a CI workflow (ruff + mypy + pytest).
- [ ] All four `check-*-new-bypasses.mjs` guards run in CI and pass.
- [ ] `ci-pr.yml` runs `apps/api` jest, `apps/web` vitest and `apps/defense-api` `tsx --test` steps.
- [ ] Every route declareable from `apps/web/src/App.tsx` **at the time of the run** has a committed baseline under `apps/e2e/baselines/`, enforced by the route-coverage guard test (not by inspection).
- [ ] `apps/e2e/baselines/manifest.json` records sha256 + capturing SHA + `purpose: regression-not-parity` per capture.
- [ ] The visual suite run **3×** on the same commit produces zero diffs (flakiness check).
- [ ] `docs/plans/cleanup1-coverage-baseline.json` exists; **no** coverage threshold configured.
- [ ] `docs/plans/cleanup1-baseline.md` records every pre-existing failure; each is fixed or in `cleanup1-quarantine.md` with an owner and expiry.
- [ ] **No test file deleted, no test case deleted, no `skip`/`only` added, no baseline generated from a failing run.** Verified by comparing §5.4-style name dumps against the §3 expectations, not by eye.

## 11. Evidence to attach

1. `RUN_SHA`, the Step 0 log, and the reconciliation against §3.
2. `pnpm gate:cleanup1` and `gate:cleanup1:python` logs.
3. Coverage baseline JSON.
4. Generated route inventory → baseline filename mapping, plus the route-coverage guard's output.
5. The 3× repeat-run flakiness log.
6. `cleanup1-quarantine.md`, if non-empty.
7. `cleanup1-progress.md` showing claimed scope (§2 R8).

## 12. Risks and rollback

| Risk | Mitigation |
|---|---|
| Visual flakiness from fonts/animations/charts | §8.2 contract; mask volatile regions; 3× repeat-run before declaring green |
| Another author moves files while this runs | §2 protocol: re-derive, re-anchor by symbol, mark obsolete, never revert |
| Route list drifts | §8.4 generated inventory + route-coverage guard test |
| A package is renamed or split | `turbo run test` rather than a hand-maintained list; record in evidence (§2 R7) |
| Playwright download size / CI time | Chromium only; cache `~/.cache/ms-playwright` |
| The api suite needs Postgres after all | Add a `postgres:16` service; do not drop the step |
| Pre-existing failures make green unreachable quickly | Quarantine with owner + expiry; never skip silently |
| Widening CI triggers blocks other people's merges | Add steps under existing triggers; do not tighten `paths:` in the same PR |

Rollback: purely additive. Reverting the merge removes only new tests, new harness files, new CI steps and new scripts.

## 13. Out of scope

Duplicate code removal (CleanUp2). Duplicate test removal (CleanUp3). Any refactor under a `src/`. Fixing pre-existing product bugs — quarantine instead. Consolidating or deleting the 20 CDP scripts — CleanUp2 §6.
