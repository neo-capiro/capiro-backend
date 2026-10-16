# Defense runtime source consolidation

Baseline: `4e0c189c5d0522098be1c4916a033bb681d11c0b` on `cleanup/backend-only-workspace-20261016`. This slice removes copied implementations, retaining the canonical backend and its existing runtime behavior. It authorizes no pipeline execution, cloud/database action, migration, security change, merge or deployment.

## Exact source boundary

`scripts/lib/defense-runtime-source-retirement.json` records every removed path, canonical surviving path, Git mode/blob, working-tree SHA256, spec classification and nonblank line count. Before removal, all **727** mirrored TypeScript files matched their canonical files in both Git identity and actual working-tree bytes. The removal check validated every absolute target remained a `.ts` file under this checkout's `apps/defense-api/runtime-source/` before deleting any file. Canonical files were never rewritten.

The **317** copied `.spec.ts` files each retain their exact canonical twin under `apps/api/src`. Canonical Jest discovery remains `apps/api/jest.config.cjs:69–75`; Defense's configured test command selects only `src/**/*.spec.ts`. Neither native package runner selected the copied `runtime-source` specs. The manifest preserves complete path/blob test-twin accounting; this source statement does not invent expanded native case counts or claim a suite ran.

All **17 data files** remain byte-for-byte: 15 JSONs and two PDFs, including the nine FY27 inspect fixture paths. The nested Procurement README is unchanged. The ownership README is updated. No LICENSE, NOTICE or provenance-named path was present in the reviewed mirror inventory; identical canonical code and its headers remain retained. The two large raw-parser JSONs and source PDFs remain, rather than deleting data to reduce a source count.

## Consumers and revised invariant

The single-thread exact literal reference pass ran before edits over tracked `apps packages scripts infra tests`: **36 matches, exit 0**. Raw results and exact argv are adjacent in `runtime-source-reference-before.txt` and `.receipt.json`. The first match references the unrelated historical `docs/runtime-source-qualification-*` directory. The actual consumers resolve as follows:

- `apps/defense-api/src/runtime/phase1-7-runtime.adapters{,.spec}.ts`, registry and replay read only the nine fixture paths. They remain unchanged. Existing stage-order, malformed-input, wrong-stage, deterministic-lineage, missing-root and byte-parity assertions remain. Both fixture-root options have always used the same compiled fixture/hash adapter; their agreement is not evidence that two independent implementations or a real parser pipeline executed.
- `scripts/verify-phase8-session4.mjs` now requires one canonical source owner via the retirement manifest, preserves all twelve canonical source slices, operator retention, original module registration, executable-boundary scanning, image containment and replay-evidence checks. Its output explicitly explains the single-code/two-fixture-root model.
- `scripts/verify-defense-budget-mirror-parity.mjs` keeps its CLI path as a compatibility entrypoint for root `verify:research-portfolios-phase0`. It now checks source ownership and retained data parity, reporting the revised meaning. Root/package/workspace/lock scripts remain unchanged in this source slice.
- `scripts/verify-research-portfolios-phase0.mjs:79–98` validates an immutable historical baseline ledger, including its historical 721-file counts. Neither that ledger nor those historical assertions were rewritten. Fresh source ownership is established by the compatibility verifier that root's command already chains after Phase 0.
- Session 2's existing checks still require no compilation/import/image inclusion from `runtime-source`. Its logic remains applicable and unchanged. The image gate still forbids shipping this directory.
- The compiled Session 4 runtime manifest remains unchanged as requested. Its original mirror lineage fields remain historical contract metadata; the new ownership manifest records current source storage and immutable retirement provenance.

The new ownership helper rederives the baseline entries from six fixed canonical Git pathspecs, independently of the manifest list. It requires all surviving canonical source/spec paths, checks baseline tree/blob provenance and complete retired-test accounting, rejects executable copies (including new TypeScript/Python names), and compares all retained data/documentation bytes with both the recorded digest and canonical copy. Current canonical code may evolve in its owner; the immutable retirement proof is not silently rewritten into a claim that future code equals the old baseline.

## Counts and focused verification

The removed TypeScript copies contain **191,226 nonblank lines**. This is the remainder of the separately accounted 191,844 copied-code lines after PR29 removed 618 duplicate operator lines. These copies were excluded from the 2,473,031 unique-authored baseline, so that headline does not drop by 191,226. Newly added helper/control code and changed verifier lines must be reported separately with the same official counting rules. Data/raw-parser/PDF/doc bytes are not source-line savings.

Thirteen small builtin ownership controls cover canonical presence, retained spec presence, reintroduced TS/Python, changed/missing retained data, canonical data drift, omitted test inventory, wrong source mapping/blob/tree, and all nine fixture identities. They use small synthetic buffers and no framework, DB, native parser, image or external service. Combined with the six existing operator controls, the requested single-process bounded run passed **19/19**, with zero failed, skipped or cancelled cases: `runtime-ownership-controls-bounded.json` and its raw stdout/stderr record exact argv, PID 25020, exit 0, no timeout, and the 60-second owned-process-tree timeout cleanup. Peak working set is unavailable because the process completed before a polling sample; no memory measurement is claimed. An earlier 19/19 run completed before the later explicit heap/isolation instruction arrived and remains recorded separately in the initial receipt.

Focused command and remaining verifier commands, to run sequentially under the integration owner:

```text
node --max-old-space-size=128 --test --test-isolation=none scripts/lib/defense-runtime-source-ownership.test.mjs scripts/lib/phase17-operator-ownership.test.mjs
node scripts/verify-defense-budget-mirror-parity.mjs
node scripts/verify-phase8-session4.mjs
```

The exact six canonical runtime pathspecs also have an empty working-tree diff after removal (Git exit 0). Changed JavaScript syntax checks, both source verifiers and the existing adapter/replay lane remain with the integration owner; the latter retains its actual fixture assertions. Broad builds/native suites belong at the shared-queue integration checkpoint. The builtin results qualify ownership controls, not native application or parser behavior.

Rollback is the inverse source patch against this exact baseline; all removed bytes remain in Git and in their unchanged canonical paths. Historical handoffs/evidence and the frozen shipping, Engagement and Objective candidates remain untouched by this slice.
