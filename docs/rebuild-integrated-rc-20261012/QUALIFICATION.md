# Source qualification

Frozen implementation `11903f32f6257a47e42f49c1abe92c0e0fb0e4fb`, tree `b10a7ed7e2e19d371ad46bfc2a6b57efdbaa997c`. These checks establish source consistency, synthetic authorization/replay behavior and compilation; they do not establish native PostgreSQL/RLS/MVCC or deployed acceptance. Existing installed dependencies were linked only into this isolated checkout; generated clients and build outputs remain ignored.

| Check | Result | Evidence |
| --- | --- | --- |
| Core combined synthetic regressions |798/798,48 suites |evidence/core-combined-regressions.json and.log |
| Workspace combined synthetic regressions |90/90,4 suites |evidence/workspace-combined-regressions.json and.log |
| Strategy combined synthetic regressions |101/101,9 suites |evidence/strategy-combined-regressions.json and.log |
| New Contacts current-authority integration |18/18; included in798 |evidence/contacts-integration-tests.json and.log |
| New importer lifecycle |4/4; included in798 |actual effective-lifecycle-integration.spec.ts and Core combined receipt |
| Primary Core / Workspace / Strategy TypeScript |exit0 each |evidence/core-types.log, workspace-types.log, strategy-types.log |
| Core / Workspace / Strategy production Nest compile |exit0 each |evidence/core-nest-build.log, workspace-nest-build.log, strategy-nest-build.log |
| Shared build / unchanged auth source build |exit0 each |evidence/shared-build.log, auth-source-build.log |
| Official pinned Prisma 5.22 WASM/DMMF + no-engine client generator |Core 459, Workspace 26, Strategy 30 models; generated schemas exact |evidence/generate-source-clients.cjs and schema-source-generation.log |
| Pure migration-history / Meri release-policy Node tests |44/44 |evidence/release-migration-guard-tests.log |
| Committed migration history guard --base 4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace |568 existing files unchanged,0 incident replacements |evidence/migration-integrity-source.log |
| Committed timestamp guard --base 4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace |PASS |evidence/migration-timestamps-source.log |
| Source/handoff whitespace |PASS; full staged raw logs contain preserved ts-jest whitespace |evidence/publication-whitespace-check.json and publication-raw-log-whitespace-warning.log |

The Jest receipts contain executed test names; launch configs map @capiro/shared to this candidate's actual source. [Audited selection](evidence/core-regression-selection.json) excludes real DB constructors/fixture suites. Representative commands: node <installed-jest>/bin/jest.js --config docs/rebuild-integrated-rc-20261012/evidence/{core,workspace,strategy}-jest.cjs --runInBand --json --outputFile <receipt>; node <installed-typescript>/bin/tsc --noEmit --rootDir . in Core and --noEmit in Workspace/Strategy; existing nest build in each service; tsc -p tsconfig.json in shared/auth; node evidence/generate-source-clients.cjs; node --test scripts/check-migration-integrity.test.mjs scripts/lib/meri-release-policy.test.mjs. Core primary compilation is not a claim that every unrelated specialized package typecheck or provider suite was executed.

All failures remain evidence:

- Final full staged whitespace check flags original ts-jest warning output in raw logs. Those bytes are preserved; source and handoff whitespace check passes. Full warning and scoped result remain under publication-whitespace evidence.

- Initial changed-spec selection overlooked an ordinary-named PGlite fixture. facility-geocode-candidate-cas.spec.ts attempted PGlite.create and failed ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG before db.exec SQL. Source-only scope required correcting the selection, not adding --experimental-vm-modules. Four DB-backed suites are excluded (Contacts.pg, facility candidate CAS, Objectives.authorization and Objectives.pg); no SQL/database or migration ran. Retained core-combined-regressions-initial-error.log. The corrected798 checks passed.
- Initial Contacts synthetic fixture used the wrong tenant feature shape; canonical helper requires clioFeatureFlags["businessDevelopment.enabled"]. Retained initial-fixture-error JSON/log; corrected18 checks pass without changing the helper.
- Initial official no-engine generator omitted the required empty engine-kind metadata maps and failed RPC validation. Retained schema-source-generation-initial-error.log. Empty maps provide no native paths; no engine was downloaded/copied/executed and no checksum control disabled.
- First successful local generation had an incorrect custom-output setting, exposing stale Workspace declarations and borrowed shared links in typechecks. Retained initial-local-resolution type/schema logs. Correct custom output and candidate-local shared links plus compiled unchanged auth now pass. The generator checks generated schema bytes against exact selected source; outputs are ignored and wrong local outputs were moved aside, not committed.
- Incorrect --run guard invocation exits2; raw initial logs retained. Correct --base invocation passes on committed source. Original Workspace migration timestamps failed existing ledger policy; only unapplied candidate names were reallocated with byte-identical SQL. Original failure and allocation proof remain.
- Conflicting merges are retained under evidence/merges. Original candidate histories remain ancestors; full Cleanup 2392 is selectively consumed and not accepted wholesale.

Independent review records are adopted separately after frozen-source review; original reviewer setup/count errors must remain beside passing receipts. No reviewer/source failures are silently discarded. Evidence hashes are verified against final Git blobs before publication.

Native Prisma downloads remain blocked by HTTPS CONNECT to binaries.prisma.sh from prior evidence; no bypass was attempted. WASM validation, no-engine declarations, synthetic SQL mocks and Nest HTTP harnesses are source checks. Native role privileges/shared physical catalog/RLS/locks/constraints/cascades, actual migration application, real provider refresh and designated frontend/account activation remain unrun. No service boot, database/migration command, messages/uploads, paid model, customer mutation, permissions/credentials/AWS/security/network operation, main merge or deployment is part of this qualification.
