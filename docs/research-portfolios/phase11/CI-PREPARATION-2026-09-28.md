# Defense correction CI preparation — 2026-09-28

These changes repair independently reproduced repository test/verifier blockers for the Research Portfolio correction. They do not change product runtime, routing, model settings, cohorts, capabilities, migrations, or live data.

- Existing CI verifier jobs receive 4 GiB Node heap capacity; no tests or exit checks are removed.
- Engagement route manifest changes only sourceLine metadata for 111 of 129 routes. Every semantic route field is identical. The full manifest equality check remains.
- Original Outreach phase scope and Phase 1 closed capability catalog use their immutable historical closeout commits, cf0aa80d8d16fbd1e775fc054e8de34570535e23 and ab45f984f33f56da7ad2ab9dbbaae6cab831fbda. GitHub compare and deepened local history confirm both ancestors of main. Current architecture and catalog metadata/foundation entries still validate; legitimate current catalog extensions do not remove the original closed-set negative control.
- Preview routing validation checks the actual boolean AST instead of exact term ordering. Both preview switches, Classic-draft precedence, and the later Classic fallback guard remain required. OR/bypass/missing-guard/changed-literal/loose-equality/extra-argument/duplicate/parse-failure controls remain active.
- LegiWatch saved-session SQL fixture now projects stream candidates from its actual temporary table with scoped IDs and deterministic ordering, and includes the temporary speaker table read by archive search. A new integration regression proves the scoped preferred official playback source. Production service code is unchanged.

## Actual evidence

| Check | Verdict | Result |
|---|---|---|
| Engagement exact previously OOM suite | PASS | 515 tests, 32 suites, exit 0 at 4 GiB after metadata refresh. |
| Outreach capability/preview negative controls | PASS | 10 tests, exit 0. |
| Current Outreach Phase 1 architecture | PASS | Exit 0, historical closed catalog plus current catalog and current architecture. |
| Saved-session fixture before repair | PASS reproduction | Native GitHub CI and owned PGlite both reproduce 3 failures / 21 passes. |
| Saved-session fixture after repair | PASS | 25 tests, exit 0 on owned in-memory PGlite. Native PostgreSQL rerun remains required in Actions. |
| API main TypeScript project after all fixture changes | PASS | tsc --noEmit --rootDir ., exit 0. Earlier complete chained API typecheck passed at 0f8086cc1; this command is narrower. |
| Owned verifier/fixture formatting and git diff check | PASS | Exit 0. Route JSON retains original formatting and source-line-only diff. |
| Complete Outreach Phase 6 verifier | BLOCKED | Historical scope and preview AST checks pass; next current-source assertion fails target-read-only-load-contract-missing. Later checks are NOT RUN. No assertion was removed to report green. |
| Remaining repository gates / main integration / AWS release | BLOCKED | Existing migration/formatting/other test failures and database reconciliation hold remain. No release clearance. |

The first PGlite attempt failed during setup without the required VM-module option; that is retained separately from the matching 3-failure reproduction. Intermediate repair/test failures are also retained. PGlite does not establish native PostgreSQL migrations, multiconnection concurrency, deployment, or populated-database acceptance.

Evidence is under C:/dev/defense-ship-20260928. Research Portfolios remains NO-GO; its existing requirement and acceptance registers are not advanced by these prerequisite tests. Local main 0ddab91669cb9eae2f2f3b7757424fe98212d52a is one commit ahead of origin/main 42942dedad59382f4b4aac6f904b9aee0e02efa6 and holds four dirty Meri files. Their owner is preparing a verified combined candidate. No reset, clean, stash, restore, main mutation, AWS mutation, migration ledger edit, or production canary was performed.
