# CleanUp3 — Remove the duplicated tests

**Status:** not started
**Depends on:** CleanUp2 complete and its gate green. CleanUp2's status file closes this plan's input list.
**Gate:** all remaining tests and all UI tests behave exactly as before — no test case silently disappears, coverage does not drop, and the Playwright suite still compares against the CleanUp1 baselines without regenerating them.
**Feeds:** CleanUp4 (`docs/plans/CleanUp4.md`), the architecture plan (data-driven registries, shared seams, twin/God decomposition). **Final duplication plan.** On completion the duplication inventory is empty apart from explicitly waived architectural seams, and the ratchet guards hold it there.

---

## 1. Interpretation decisions (correct these if wrong)

* This plan removes **duplicated tests only**: duplicated test helpers and duplicated spec files that CleanUp2 deliberately preserved.
* **Behaviour must be provably unchanged.** A consolidated helper must produce the same fixture values; a table-driven spec must still assert the same things. "The suite is green" is not evidence — it was green before. The evidence is a mechanical **test-name diff** (§7).
* A consolidated spec may legitimately **add** names (`it.each` expands one `it` into one per matrix cell). Adding is fine. Removing is not. **Changing** a name requires an explicit before→after mapping recorded per conversion.
* No production code changes here. If one turns out to be necessary, it goes back to CleanUp2.
* Baselines are **not** regenerated. A changed pixel is a failure.

---

## 2. Evidence is a snapshot — re-validation protocol

> **Read before using any number below.**

All counts were measured against commit **`67bab09`** — the commit every `graphify-out/*/graph.json` records as `built_at_commit`, with a clean tree. It is an expectation, not a fact about your execution day.

* **R1 — Re-derive before you act.** §3 and §4 are generated at run time (§6). The live tree wins.
* **R2 — Anchor on identities, not positions.** Duplicates are identified by `(symbol name, source_file)`. **No line numbers are given in this plan** and none should be searched for.
* **R3 — Counts are expectations with tolerance.** A few percent difference needs an explanation; >10% means another author worked there — stop and re-scope.
* **R4 — A vanished group is "already removed", not "error".** Record it `obsolete` with the removing commit. Never recreate a test to satisfy a plan.
* **R5 — Never resolve a conflict by reverting another author.** Re-read, re-run the affected verification instead.
* **R6 — The graph is a snapshot; the source is truth.** The inventory scripts read `graphify-out/01-api/graph.json`. Rebuild before generating. Known blind spots: nodes with an empty `source_file` (decorator/annotation kinds) were excluded from every scan, and `*.e2e.spec.ts` bodies are excluded by pattern — so this plan's input under-counts e2e test bodies.
* **R7 — Guard against silent scope loss.** New suites or runners added by another author must be *noticed*, not skipped. §7's harness enumerates suites at run time and reports scope changes separately from test changes.
* **R8 — Claim your scope.** Append `claimed_by / started_at` to `docs/plans/cleanup3-progress.md` before starting a workstream.
* **R9 — Human state is separate from generated state.** Never hand-edit a generated inventory; decisions live in `docs/plans/cleanup3-test-name-ledger.md`, keyed by suite + test name.

---

## 3. Input — generated, not transcribed

> **Regenerated at `a533ad1`.** The ledger was regenerated after a full graph refresh (the generator
> reported `unresolved nodes: 0`), so the counts below are current. The mirror note carried in from
> CleanUp2 §3.2 holds at **730** mirrored `.ts` files.

```bash
git rev-parse HEAD                 # RUN_SHA
git status --porcelain
.graphify-venv/Scripts/python.exe .graphify_ledger.py     # writes all three ledger files
```

Then work the **test-area** rows from `docs/plans/cleanup2-dup-status.md` — CleanUp2's status
file *is* this plan's work list. Filter the ledger by `wave = CleanUp3`.

Totals at `a533ad1`: **558 groups / 9,381 lines** (417 STRICT-identical; was 488 / 8,590 at `67bab09`). By subject — and note
that **`apps/web` now leads, not `apps/api`**:

| subject | groups | wasted lines |
|---|---:|---:|
| `02-web` (`apps/web`) | 168 | 4,040 |
| `01-api` (`apps/api`) | 263 | 3,892 |
| `05-strategy` | 19 | 331 |
| `04-meri` | 22 | 176 |
| `08-platform` | 9 | 108 |
| `06-intel` | 6 | 41 |
| `03-defense` | 1 | 2 |

Top duplicated test helpers, from the ledger:

| Helper | Copies | Lines/copy | Wasted | STRICT | Module |
|---|---:|---:|---:|---|---|
| `setupBrowserMocks()` | 23 | 22 | 506 | yes | `apps/web` |
| `setupAntdBrowserMocks()` | 17 | 21 | 336 | yes | `apps/web` |
| `client` | 15 | 17 | 238 | yes | `apps/web` |
| `setupBrowserMocks()` (second cluster) | 9 | 26 | 208 | yes | `apps/web` |
| `ctx` | 25 | 7 | 168 | no | `apps/api` |
| `ctx` (second cluster) | 24 | 7 | 161 | no | `apps/api` |
| `assertLocalFixtureDatabase()` | 17 | 10 | 160 | no — 17 distinct variants | `apps/api` (`meri`) |
| `repositoryPath()` | 16 | 9 | 135 | yes | `apps/api` (`knowledge/entities`) |
| `setupBrowserMocks()` (third cluster) | 7 | 22 | 132 | yes | `apps/web` |
| `hr8800()` | 2 | 120 | 120 | yes | `apps/web` fixtures |
| `setupApi()` | 2 | 105 | 105 | yes | `apps/web` |
| `table` | 3 | 47 | 94 | no | `apps/api` |
| `run` | 10 | 9 | 81 | no | `apps/api` |

Note the **three separate `setupBrowserMocks()` clusters** (23, 9 and 7 copies). They are
different bodies, not one group — do not merge them as a single helper without checking whether
the differences are meaningful. Same for the two `ctx` clusters.

Also in scope — duplicated **spec files**:

| Spec | ~Lines | ~Tests |
|---|---:|---:|
| `defense-budget/stages/appropriations/hacd/hacd-composer-v1.spec.ts` | 356 | 7 |
| `defense-budget/stages/appropriations/sacd/sacd-composer-v1.spec.ts` | 387 | 9 |
| `defense-budget/stages/authorization/hasc-composer-v1.spec.ts` | 430 | 13 |
| `defense-budget/stages/authorization/sasc-composer-v1.spec.ts` | 436 | 11 |
| `defense-budget/stages/authorization/ndaa-conference/ndaa-conference-composer-v1.spec.ts` | 346 | 9 |

Pairwise symbol-set Jaccard: `hacd↔sacd` 0.88, `hacd↔sasc` 0.88, `sacd↔sasc` 0.88, `hacd↔hasc`
0.82, `sacd↔hasc` 0.82, `hasc↔sasc` 0.82.

Lower-similarity candidates to **investigate, not assume**: `promotion/readiness/`
family-certification pair (~0.41); the `sync-tango-entities` ↔ `sync-tango-vehicles` script specs.

**Two constraints carried in from CleanUp2:**

1. **Mirror obligation (§3.2 there).** Test helpers under `apps/api/src/defense-budget/**` are
   inside a mirrored tree — if a consolidated helper lands there, the mirror copy must change in
   the same commit or `verify-phase8-session4.mjs` fails. Prefer putting shared test helpers
   *outside* the mirrored trees where possible, which sidesteps the obligation entirely.
2. **If the `rdte`/`non-rdte` ADR concludes "one pipeline, N profiles"**, the chamber composer
   specs may be superseded by a profile-driven spec rather than merely consolidated. Read that
   ADR before starting Workstream B.

## 4. Workstream A — Consolidate duplicated test helpers

Choose one home and record it in the PR. Recommendation:

* `apps/api/src/__testing__/` for cross-module fixtures (`makePrisma()`, a generic service factory, `createApiTestingModule()`).
* `<module>/__testing__/` for module-local ones (the `meri` fixture-database helper, `knowledge/entities` `repositoryPath()`).
* `apps/web/src/test/` for the web helpers (`setupBrowserMocks()`, `setupAntdBrowserMocks()`, `setupApi()`, the shared `client` fixture) — this directory already hosts `apps/web/src/test/setup.ts`, so extend the existing convention rather than adding a second one.
* `apps/defense-budget-parser/tests/conftest.py` for Python — pytest's own mechanism; no new pattern invented.

Procedure per helper, and **only** per helper:

1. Create the shared implementation as an exact copy of the most common variant, with the drift points as explicit parameters.
2. Repoint every declaring spec. Assertions untouched, names untouched.
3. Run the test-name diff (§7) and `pnpm gate:cleanup1`.
4. Delete the local copies.
5. Re-run the diff and gate.
6. One helper per PR.

Watch-outs:

* `assertLocalFixtureDatabase()` (~18 declarations, ~17 distinct variants) is **not** copy-paste — it is 17 subtly different fixtures. Diff first; expect this to take real work or to be partially waived.
* `ctx` spans ~20 clusters with differing variant counts, and `setupBrowserMocks()` appears as **three separate clusters** (23, 9 and 7 copies). Treat each cluster separately; never attempt one global `ctx` or one global `setupBrowserMocks()`.
* Helpers often capture module-local constants. Parameterize explicitly rather than reaching for a global, or a repointed test will silently assert against the wrong fixture.

---

## 5. Workstream B — Consolidate duplicated spec files (highest risk)

The chamber composer family is exactly the shape of change that silently drops cases.

Procedure:

1. Dump current test names for all five files (§7) into `before-composer.json`.
2. Write one profile/chamber-driven `composer-v1.spec.ts` reproducing **every** existing case for every chamber.
3. Dump into `after-composer.json`.
4. Diff. The after-set must be a **superset** of the before-set, or every difference must be an explicitly mapped rename (§7.3).
5. Only when the diff is clean, delete the superseded files.
6. Re-dump and re-diff. Family test count must be ≥ the before count.

Same procedure for the family-certification pair and the Tango sync-script specs — but treat "these two files are the same test" as a **hypothesis to be checked against the name dump**, not a given, because their similarity is only ~0.41.

**If a conversion cannot reproduce a case, keep both files.** A duplicated spec is a smaller problem than a lost test, and this is the one plan where "I couldn't work out how to merge it safely" is an acceptable outcome, recorded as a waiver.

---

## 6. Workstream C — Remove CleanUp2's orphaned test copies

CleanUp2 repointed specs at canonical implementations, which can leave test-local copies of production helpers behind. Sweep for them with `tsc --noEmit` (unused-import diagnostics) and the repo's lint config, and remove them here — they are test-area duplicates, which CleanUp2 was told to leave alone.

Do **not** use a blanket "delete every unused export in a spec file" sweep: a helper can be unused at the top level but still referenced from a generated case list. Re-run the name diff after each removal.

---

## 7. Workstream D — The verification harness (the whole safety net)

"All tests perform exactly as before" is made mechanical. Five runners exist in this repo and all five are covered:

| Runner | Packages (at `67bab09`) | Name dump |
|---|---|---|
| jest | `apps/api`, `apps/workspace`, `apps/api-strategy`, `apps/intel-api`, `apps/onboard-api`, `apps/meriv2-orchestrator`, `packages/auth`, `packages/meriv2-core`, `infra/cdk` | `jest --json --outputFile=…` → `testResults[].assertionResults[].fullName` |
| vitest | `apps/web`, `apps/onboard-web` | `vitest run --reporter=json --outputFile=…` |
| node:test | `apps/defense-api` (`tsx --test`) | `tsx --test --test-reporter=tap` → TAP `ok N - name` lines |
| pytest | `apps/defense-budget-parser` | `uv run pytest --collect-only -q` → node ids |
| playwright | `apps/e2e` | `playwright test --list` |

### 7.1 `scripts/dump-test-names.mjs` (new)

One script, five adapters, one output shape:

```json
{ "runner": "jest", "package": "@capiro/api", "tests": ["<suite> > <name>", "…"] }
```

Enumerate packages **at run time** (glob `apps/*/package.json` and `packages/*/package.json`, read `scripts.test`) rather than from a checked-in list, so a package added by another author is included rather than silently skipped (§2 R7).

### 7.2 `scripts/diff-test-names.mjs` (new)

Inputs: two dumps. Outputs four sets, and exits non-zero on anything but additions:

* `added` — permitted (a spec may grow; `it.each` expands).
* `removed` — **blocks**, unless §7.3 applies.
* `changed` — **blocks**, unless §7.3 applies.
* `scope-changed` — packages gained/lost since the previous dump. Never silent: it must be reported and acknowledged, because a suite that vanished looks identical to a suite whose tests all disappeared.

### 7.3 The removal rule

> A **removed** name is acceptable only when an identical-twin name from the same consolidation commit is still present, or when it appears in the explicit rename map.

A **changed** name is acceptable only when the conversion PR records the before→after mapping in `docs/plans/cleanup3-test-name-ledger.md`. Table-driven conversions legitimately rename things (`it('renders X')` → `it.each(…)('renders the %s fixture')`); the mapping is the proof that this was deliberate rather than incidental.

Anything else blocks the merge. This single check is what makes the gate believable — without it, a consolidated helper that quietly stops exercising three cases passes review.

### 7.4 Ledger

`docs/plans/cleanup3-test-name-ledger.md`: per runner and package, the before count, the after count, every removal with its surviving twin, and every rename with its mapping.

---

## 8. Workstream E — Re-verify coverage and visuals

1. **Coverage must not drop.** Run `test:coverage` per package before and after; compare against `docs/plans/cleanup1-coverage-baseline.json` and CleanUp2's post-run numbers. A drop means a test stopped exercising something — return to §7.
2. **Visuals unchanged and compared, not regenerated.** Run Playwright against the CleanUp1 baselines. No `--update-snapshots`. `git diff --stat apps/e2e/baselines/` must be **empty**, including additions — a *new* baseline appearing means a spec was added or a route appeared, which this plan must justify explicitly rather than absorb.
3. **Route coverage still holds.** CleanUp1 §8.4's guard test (every route declared in `App.tsx` has a baseline) must stay green.
4. Ratchet guards pass: `check-duplicate-helpers.mjs` plus the four architecture-bypass guards.

---

## 9. Gate criteria

- [ ] §3 pre-flight recorded; divergences from the stated expectations reconciled in writing.
- [ ] `cleanup2-dup-status.md` has zero remaining rows for test-area groups; every row is `merged`, `waived` or `obsolete`.
- [ ] `cleanup3-test-name-ledger.md` accounts for every removal and every rename.
- [ ] `pnpm gate:cleanup1` green, including `gate:cleanup1:python`.
- [ ] **Name diff clean for all five runners:** zero unexplained `removed`, zero unmapped `changed`, and any `scope-changed` acknowledged rather than ignored.
- [ ] Every removed test name has an identified surviving twin, or is recorded as a helper (not a test case) with its replacement named.
- [ ] **Playwright baselines byte-identical to the CleanUp1 set.** `git diff --stat apps/e2e/baselines/` is empty.
- [ ] Playwright visual comparison passes with zero diffs; no baseline regenerated.
- [ ] CleanUp1 §8.4 route-coverage guard green.
- [ ] **Coverage ≥ the CleanUp2 number for every package.** No threshold is added to config in this plan.
- [ ] Line-count delta recorded (expect roughly **−9,381 test lines** at `a533ad1`: `02-web` and `01-api` dominate, plus the smaller subjects). Re-derive rather than quoting these.
- [ ] No `skip`, `only`, `todo`, `.skip` or `.only` added anywhere — verified by grepping the diff, not by review.
- [ ] `scripts/check-duplicate-helpers.mjs` and the four architecture guards pass; the redundancy scan now reports duplication only in waived categories.

## 10. Evidence to attach

1. The test-name ledger: before/after counts, removals with twins, renames with mappings.
2. `diff-test-names.mjs` output per runner, per wave.
3. `pnpm gate:cleanup1` and `gate:cleanup1:python` logs.
4. Playwright run showing zero diffs, plus `git diff --stat apps/e2e/baselines/` (empty).
5. Before/after coverage JSON per package.
6. A fresh redundancy scan showing remaining duplication is only the waived categories.
7. `cleanup3-progress.md` showing claimed scope.

## 11. Risks and rollback

| Risk | Mitigation |
|---|---|
| A table-driven spec silently drops cases | §7 name diff — mechanical, and the primary control |
| A consolidated helper subtly changes fixture values | Repoint → gate → delete → gate. Delete last |
| Coverage quietly drops | §8.1 compares before/after; any drop blocks |
| A baseline regenerated to hide a diff | §8.2 requires an empty `git diff --stat apps/e2e/baselines/` |
| A suite or package disappears without anyone noticing | §7.1 enumerates at run time; §7.2 reports `scope-changed` explicitly |
| Another author edits specs mid-wave | §2 protocol; re-dump names, re-diff, obsolete rather than recreate |
| Helper consolidation touches 80+ spec files per helper | One helper per PR; the name diff is cheap to re-run |

Rollback: each helper and each file conversion is an independent commit. Reverting restores the duplicates and reopens the ledger row.

## 12. Out of scope

Any production code change (CleanUp2, or a new plan). The waived duplication from CleanUp2 §11 — the 8 context-plane adapters, the 12 capabilities, the `migration.sql` basenames, and `rdte`/`non-rdte` pending its ADR. Adding coverage thresholds — worth doing afterwards as a separate small change, so this gate measures "unchanged" rather than "improved".

## 13. Completion statement

When this gate closes:

* the duplicate inventory is empty except for explicitly waived architectural seams, each with a written reason keyed by stable id;
* every unit, integration, Python and UI test that existed before CleanUp1 still exists, or has a recorded surviving twin or rename mapping;
* the Playwright suite compares against baselines captured before any code was touched, across all three plans, proving no user-visible change occurred;
* `scripts/check-duplicate-helpers.mjs` and the four architecture-bypass guards hold the line against regression.
