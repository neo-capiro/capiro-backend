# First backend cleanup slice

Removed three identical copied defense operator implementations (618 nonblank lines) and retained their canonical `apps/api/scripts` owners. The Session 4 verifier now requires canonical commands and rejects a duplicate operator tree. All runtime/domain/fixture mirror pairs and replay contracts remain unchanged. No frontend, application, shared package, migration, module, schema, configuration, license or provenance file is removed.

The [reference map](REFERENCE-MAP.md) records retained frontend/runtime/feature ownership and exact build, deployment, test, import and operator consumers before editing. It was committed first at `b794fe151`. The focused implementation is `967b0e4b67862f780a5a41cb8891b74ef379df07`, directly above that map. Later commits in this packet contain evidence/docs only. Both source commits are recoverable; revert the implementation commit to restore the three copies and old verifier/README.

## Counts

| Count using the016e method | Before | After | Change |
| --- | ---: | ---: | ---: |
| Unique source, including tests/scripts/frontend | 2,473,031 / 10,136 files | 2,473,087 / 10,138 files | +56 lines / +2 files |
| Copied runtime source, counted separately | 191,844 / 730 files | 191,226 / 727 files | -618 lines / -3 files |
| Physical source including copied runtime | 2,664,875 / 10,866 files | 2,664,313 / 10,865 files | **-562 lines / -1 file** |

These are nonblank UTF-8 source lines including comments, not language-aware SLOC. The unique headline rises because the added ownership guard and six regression cases are unique source. No general deduplication, frontend retirement or coverage improvement is claimed. [CODE-COUNTS.json](CODE-COUNTS.json) combines the sealed baseline receipt (SHA256 `fad456de08566e2e7857a0b104d18d446362ace22696d06b8219c1620e63fed6`) with exact Git-blob deltas for all six changed code paths. Docs/README and supplemental data/config retain the baseline exclusions. No full repository rescan was needed. Reproduce from the source checkpoint using `node --max-old-space-size=128 docs/backend-cleanup-20261016/count-delta.cjs <sealed-baseline-receipt.json>`; the external baseline receipt is retained in task-10 evidence and task-3 owner custody.

## Verification

- Six built-in ownership controls: **6 pass, 0 fail/cancel/skip/todo**, exit0, one Node process, 128 MiB heap ceiling, 60-second hard wall. The process exited before the first100ms memory sample, so its recorded peak0 means unmeasured, not zero memory use.
- Existing Session 4 source verifier: **SESSION4_SOURCE_PARITY_PASS**, exit0 before commit and at committed implementation checkpoint. The postcommit run used about38.8MiB sampled peak parent working set; its eight synchronous Git tree reads completed. This is source parity only; FY27 behavioral replay remains unenforced and explicitly reported by the verifier.
- No diff against016e in `apps/api`, `packages`, Defense `src`/package/Dockerfile, or mirrored Defense/Program Element trees. Canonical operator blob/mode identities and all feature/schema/migration files remain unchanged. Whitespace check passed.
- [Independent review](INDEPENDENT-REVIEW.md): no concrete code blocker within the bounded slice.

Actual stdout/stderr/exit/owned-process cleanup receipts are retained under `evidence/`. Fresh approved memory read before this batch reported2,863,403,008 free virtual bytes; the initial unavailable performance-counter/CIM probes are recorded separately. No compiler, framework suite, browser, dependency install, DB, provider, image, cloud, migration, merge or deployment ran. Full-suite/build/image verification is deferred to the coordinated integration checkpoint, not reported as passed.

## Integration and remaining work

The cleanup branch is stacked on preserved Engagement PR27 exact016e. Its application behavior remains unchanged. Objective622 and inactive docs PR28 remain separate candidates; merge Objective30000 and Engagement40000 model/backref hunks fieldwise, without replacing shared schema/modules/planner/index files. Frozen shipping cd3 and live capirov2 remain untouched. The local cleanup clone uses read-only alternates in task-3 `backend-plan-implementation/.git/objects` and its existing `backend/.git/objects`; keep both stores until this clone is archived or made independent.

Further frontend removal requires a coherent workspace/frozen-lock/image/artifact/URL/E2E-evidence/mixed-verifier transition. Default Web/Onboard images and retained UI contracts are still source consumers. Whole runtime-tree consolidation needs equivalent runtime/fixture/acceptance consumers redirected deliberately. These are follow-on implementation boundaries, not a reason to stop this completed three-copy slice or delete active behavior. Do not infer global Cleanup acceptance, deployed-build equivalence, feature readiness or production cutover from this PR.
