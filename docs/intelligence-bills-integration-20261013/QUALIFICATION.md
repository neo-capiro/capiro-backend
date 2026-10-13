# Receiving source qualification

All receiving runtime and compiler checks bind source `f7c42c18d1ad0c8cda6e4eaf929bcf2c333b0d05`, tree `78333f25f1c40271640bb3f221cca001d57671ad`. No source changed after the merges or between these checks. Only this documentation packet changed afterward.

| Check | Result / evidence |
| --- | --- |
| Affected Intelligence regression | [Jest receipt](evidence/jest-receipt.json), [summary](evidence/jest-summary.json) and full structured results: 33/33 suites, 488/488 tests, zero failures/skips, 15.500s. Selection contains all 20 donor specs, 12 retained profile/controller/budget/regulatory/setup specs and tracked-bill similarity-floor regression. |
| Strict API type | [Receipt](evidence/type-receipt.json): exit 0, 125.328s, empty log. Actual API tsconfig, cold owned build-info, no emit, rootDir override only for inherited project layout. |
| Actual Nest build | [Receipt](evidence/build-receipt.json): exit 0, 96.790s, empty log. Actual production build config/source/exclusions and installed Nest CLI. Temporary config changes only output/build-info location and deleteOutDir=false for new empty output roots. |
| Emitted delta / DI | [Inventory and retirement](evidence/build-output-retirement.json): 3,892 emitted files / 36,510,243 bytes, 17 changed production modules syntax-pass, actual three-dependency constructor metadata retained, no spec/fixture output. Complete names/sizes are retained compressed; protected reporting output contents are not read. |
| Exact source composition | 41 final-donor paths and 26,496 unchanged base entries; 33 authority inputs and published Calendar/Workspace/shared contracts unchanged. [Source audit](evidence/source-composition-audit.json). |
| Independent static review | [AST evidence](evidence/independent-source-ast-audit.json) and reviewer note: signatures, whole unrelated methods, exports, DI and SQL templates/bindings retain identity; tenant scope, conditional awaits and transaction/idempotent command order are reviewed. No native execution follows from this evidence. |

Dependencies are reused from existing installed source-compatible caches, without installation, generation, native download or checksum changes. API shared resolution uses the already compiled exact product shared source. Jest runs sequentially in the inert source host; no full AppModule, database, network, child process, provider, timer worker or real authentication is started. The complete previously accepted Completion suites and owner's separate before/after/coverage matrices are carried unchanged, not rerun here.

Build output placement was split across two owned roots because neither filesystem had enough free space for the whole output. The defense-budget output symlink changes placement only; production source and exclusions are unchanged. Both roots and owned type/build info were retired after inventories. Borrowed dependency/shared/generated-client caches and all source are retained.

The initial post-build DI inventory assertion expected `_1` import aliases instead of actual `_js_1` aliases. Its tool failure and mistaken preliminary diagnosis are retained in [the observation](evidence/inventory-initial-assertion.json). Corrected metadata validation passed against the same build; no source change or build rerun occurred. All receiving type, build and Jest raw observations survive. The whitespace-bearing Jest log is retained losslessly through its raw ancestor and a bounded exact envelope after publication preparation.

Type/synthetic/source checks do not establish native PostgreSQL/RLS, live authorization, database transaction concurrency, provider behavior, runtime/artifact ABI, schema execution, active Files 90 policy, live-image equivalence or deployment. No main merge, deployment or prohibited external effect occurred.
