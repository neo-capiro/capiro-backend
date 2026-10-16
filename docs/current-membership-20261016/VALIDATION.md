# Source validation state

The seven production files passed independent source review, with both concrete findings corrected: no-store headers cover the router's case/trailing-slash aliases, and request control rejects an already-destroyed response before registering listeners. `SOURCE-REVIEW.md` preserves exact production hashes. Syntax transpilation passed; this is not semantic typing.

| Evidence | Result | Limit |
| --- | --- | --- |
| Focused attempt 1 | Two runtime-error suites, zero cases; primary 1 / cleanup 0 | Wrong Jest project binding selected Babel instead of TS-Jest. No authentication assertion executed. |
| Corrected config-only preflight | 13/13 guards passed at 128 MiB | Effective actual-source TS-Jest/root/setup/one-worker configuration only; no tests. |
| Focused attempt 2 | Actual Nest/controller suite **42/42 passed**; service VM suite 17/28 passed, 11 failed; total **59/70**; primary 1 / cleanup 0 | Source/config hashes unchanged. Failures occurred at member Date validation in VM positives and downstream cases. Not a successful full qualification. |
| Narrow fixture reproduction and independent review | Established foreign-realm Date after Node `structuredClone`; reboxing preserves exact time and invalid NaN | Only the VM fixture clone helper changed. No assertions or production code changed. Exact old spec reconstructed to the attempt-2 SHA. |
| Targeted VM rerun | **PENDING** serialized qualification queue | All 28 cases must be rerun, including negatives that could previously have failed before reaching their intended checks. Reuse the unchanged 42-case Nest proof. |

Attempt 1: PID 30996, 2026-10-16T02:51:13.773Z to 02:51:29.772Z, 15.990 seconds; observed peak working set 265,326,592 bytes / sampled private 276,180,992 bytes. Attempt 2: PID 40272, 03:07:44.895Z to 03:08:06.923Z, 22.020 seconds; observed peak working set 434,798,592 bytes / sampled private 449,978,368 bytes. Both used one serialized Node process with a 512 MiB old-space ceiling and a 58-second hard stop; neither timed out or left an owned process. These are observations, not guaranteed total-memory bounds.

Full logs, before/after source hashes, effective configuration, case-level results and primary/cleanup receipts remain in task-root `current-authority-runtime/focused-attempt{1,2}.*`. Config diagnosis, both corrected config preflights (including the initial normalized-flag guard failure), Date reproduction and fixture review are preserved. No automatic retry or unrelated suite was run.

The current nine-file source/test digest is in `SOURCE-MANIFEST.json`; it includes the corrected fixture. The unchanged registered Nest suite applies to those exact production and module-test bytes. A future passing targeted proof must be added explicitly; pending work is not a pass.

No broad typecheck/build/browser/native HTTP/SQL/startup integration or live authority call has been run for this increment. These remain at the reviewed integration checkpoint. No deployment, route activation, live-availability or retained-resource authorization acceptance follows from this source candidate.
