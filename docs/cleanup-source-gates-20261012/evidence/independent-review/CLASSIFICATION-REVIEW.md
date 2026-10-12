# Independent Cleanup applicability and formatter review

Initial integrated source: `243248e726243c44bd4b9d24fd1ed220da18c56a`, tree
`d8f01afa7eca0e6571e7ed3669905fea3491bbdd`. Its runtime source remains identical to
the previously accepted implementation11903. Accepted formatter repair:
`a0947f47ff8146cd986dd23b5e95d489aba855cf`, tree
`d6c9d0b4c4a3836576576ebd12a90c30f0520d1f`. Review worktree is
`/workspace/capirov2-cleanup-review`; the author worktree and original candidates
were not edited by this reviewer.

Independent exact YAML parsing found two applicability-evidence corrections.
The original API Jest regex matched the actual api-strategy command, so apiJest
was a false positive. Current ci-pr.yml has no direct Core API, Web or Defense test
step. Strategy's direct test step exists. Text scanning also reported a context
guard execution in knowledge-phase18-ci.yml, where it is only a comment/reference.
Actual context execution is in context-plane-architecture-guard.yml only. The other
three architecture guards are not wired into run steps. Author intermediate scope
logs are retained; the independent parsed-YAML receipt controls these findings.
No workflow or release gate was changed to make the audit pass.

The finite source gaps are inherited from main: eleven absent Cleanup carrier,
configuration, fixture, E2E and Python CI paths; four missing test:coverage scripts;
three unwired architecture guards; and the three absent direct test steps. These
are distinct from two unrun owned runtime evidence paths, namely script-smoke
and pinned visual regression evidence. Discovery with the original published
Cleanup functions finds thirteen test-bearing packages and no unsupported runner.
Discovery is not executed full-workspace acceptance. Six imported/reference tool
files were independently verified unchanged from published Cleanup2392.

The 49/51 test-proof fixture run measures the original Cleanup2392 tooling source,
not integrated RC acceptance. Its two failures are environment/toolchain failures:
installed pnpm11.25.0 requests an implicit install and fails creating its external
store before the fake runner produces JSON. Source packageManager is pnpm9.12.0.
The child reports zero tests and no generated report. No store permission,
installation, pnpm option, native dependency or checksum workaround was attempted
in this review. Original erroneous target-source metadata was retained separately
from the corrected actual reference source. The failed fixture is not a functional
composition regression or a green test.

Intel and Onboard initially lacked their custom generated declaration output;
their service and configuration blobs are unchanged from main. Author source-only
official5.22 WASM/no-engine declaration generation resolved the typecheck cascades
without service edits. Core's declared typecheck sequence has seventeen steps,
including sixteen actual compiler invocations and one static safety script.
Defense's direct compiler diagnostic passes while its canonical command's native
Prisma generation prerequisite remains unrun. Declaration/type evidence is not
native Prisma/PostgreSQL acceptance. Remaining plain workspace compiler results
and full suite counts are supported by the author's raw per-command receipts.

The full Meri orchestrator catalog-count failure was reproduced on main with
unchanged catalog/test blobs (expected138, actual139). Its assertion remains
unchanged and red. Existing TODO/live-skip statuses remain visible. Full formatter
scope failed on48 main files versus49 initial RC files. Forty-seven other baseline
files remain untouched; the shared index was already baseline formatting debt but
is touched by composition and must pass the changed-file gate. The new saved
Workspace helper supplied the other changed-file formatter gap.

The repair modifies exactly packages/shared/src/index.ts and
packages/shared/src/workspace-saved-revision.ts with standard Prettier3.9.9.
Independent TypeScript AST comparison preserves every identifier, literal, SQL,
template value and parsed structure, ignoring only redundant ParenthesizedExpression
wrappers. Emitted JavaScript semantic ASTs are identical. Index JavaScript bytes
are identical; saved-helper emitted layout differs with identical semantics.
The initial hash receipt trimmed EOF newlines; that receipt is retained and the
corrected receipt hashes complete Git source bytes. Original source heads remain
preserved. The canonical Objective helper, exports, owner behavior, guards,
schemas, migrations and test assertions are unchanged by this repair.

Independent focused regression results on exact accepteda094:

| Check | Result |
| --- | --- |
| Core Objective/Newsletter suites, including published staging adversarial controls |127/127,7 suites |
| Workspace saved-version/Objective suites, including published independent controls |172/172,5 suites |

These runs overlap earlier owner receipts and must not be added to author/reviewer
totals. The original Workspace independent fixture is unchanged; a copied review
fixture only rebinds its old2028 migration path to the current allocated2026 path
after exact SQL-byte comparison. Its assertions and names are retained. Existing
WASM/no-engine declarations were linked read-only after schema-byte verification.
Database authorization environment names were removed; no DB/PGlite, provider,
cloud, full turbo/native command, service boot, credentials/permissions, deployment
or main merge ran in this review.

The six changed shared files pass the author's formatter check after repair.
The whole formatter still fails on47 unchanged baseline files. Original Cleanup
acceptance therefore remains open. The catalog failure, toolchain/Python/native
prerequisites, missing source carrier/CI/coverage wiring, runtime evidence,
PostgreSQL/RLS/role/constraint/MVCC/concurrency and inherited client/grant deadlock
qualification remain explicit. Unpublished scoped reporting remains excluded and
untouched. No gate weakening or unrelated baseline repair is approved here.
