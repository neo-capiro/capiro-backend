# Retained preparation diagnostics

The original source proof first compared all60 cases in global Jest suite execution order. Jest reordered the three suites after the stronger case changed execution cost. The raw assertion failure is `initial-source-case-checks.stderr`; no tests/results were changed. The corrected proof compares case-name/status/assertion multisets and separately proves original source case order. It still requires all60 cases, all original names, no skips/todo, all59 unrelated assertion counts and six other owner bodies byte-exact.

The initial focused TSC command omitted the existing API cached typeRoots and failed with TS2688 for node/jest declarations. `initial-focused-types.stdout/.stderr` are raw. Corrected command adds only `--typeRoots apps/api/node_modules/@types`; source and strict/noUnchecked settings remain unchanged. The rejected2322 passing type receipts are also retained separately.

The editor-only intermediate after-run was on an uncommitted working tree based277; its command's Git head identifies the baseline, not a source freeze for that intermediate. The raw result remains a diagnostic of the second stale positive. Only final8048 and original277 runs are used for exact before/after acceptance.

The independent rejected2322 four-input probe's original source and JSON are retained. The replay changes only the output filename and source receipt metadata. The corpus and actual callback are unchanged; mutated UI/fixture source is never executed. All original three escapes are refused on corrected8048.

The final nine-input probe snapshot records the rejected8048 outcomes; final1f285 replay changes only output filename/source metadata. Deferred imports, computed callback keys and top-level binding mutations are refused. The earlier uncommitted HANDOFF/index were copied before the final grammar change as historical author snapshots; their old result paths have retained version-prefixed copies and are not a current-path acceptance index.
