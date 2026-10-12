# Source checks and failure classification

Measured parent243248 and format-only repaira094 are pinned in
[SOURCE-OVERLAY.json](SOURCE-OVERLAY.json). All commands retain raw output and
metadata under `evidence/`; a wrapper exit0 is not a leaf pass. Leaf exit codes,
timeouts, test names and statuses control the result. Original configured skips
and TODOs are reported explicitly. Counts across prior/author/reviewer runs overlap.

| Source check | Result and limit |
| --- | --- |
| Core declared typecheck sequence |17 steps pass:16 compiler invocations plus existing static safety script. |
| Workspace compiler coverage |18 package compiler targets pass after source declaration preparation; Defense direct compiler diagnostic passes while its canonical native-Prisma prerequisite is unrun. |
| Additional official5.22 WASM/no-engine declarations |Intel50, Onboard14 and Defense40 models; generated schema bytes match selected source. No native engine or DB execution. |
| Four architecture guards |All pass; parsed YAML finds only context guard actually wired in CI. |
| Structural/hash mirrors |Structural verifier passes;723 corresponding files remain byte-identical. Native behavioral replay is unrun. |
| Meri isolation/import/adjacent boundaries |Production scans pass;49 fixture checks pass. |
| Build isolation |Python static verifier passes;14 self-tests and5 orchestrator build-contract checks pass. |
| Migration history and timestamp guards |568 existing migrations unchanged; timestamp guard passes;33 synthetic history controls pass. No migration executed. |
| Migration invocation/entrypoint controls |39 Node and4 Python checks pass with inert command stubs. |
| Release-policy controls |37 pass with injected local stand-ins; no AWS operation. |
| Standalone Node suites |84/84 across8 discovered files; provider/cloud names denote inert injected fixtures. Two mixed DB/bootstrap files are unrun. |
| BYOK CI static rule |Pass; source references only, no credential values read. |
| Auth full unit suite |20/20,1 suite. |
| Meri-core full suite |1717 pass,2 existing TODOs,117 suites. |
| Meri orchestrator full suite |1695 pass,1 fail,2 existing live skips; the catalog count failure reproduces on exact main. |
| Strategy full source suite |2026 pass,195 existing optional tests unrun,123 passing/20 skipped suites. No added skip or altered Jest selection. |
| Onboard API full unit suite |60/60,6 suites; DB and OAuth transports are mocked. |
| Onboard Web full unit suite |23/23; Vitest's5 suite records include nested descriptions in1 test file. |
| CDK source fixtures |47 Jest and188 Node checks pass using local construct/template assertions. No deployment or cloud API. |
| Changed shared formatter scope after repair |6/6 files pass. Whole formatter remains red on47 exact-main files. |
| Independent repair review |TS/emitted-JS semantics equivalent; Core127/127 and Workspace172/172 pass. |
| Web full source suite |6433 pass,2 fail across701 physical test files;1963 Vitest suite records include nested describes. No skips/TODOs or timeout. Main full6434 pass/1 fail, same6435 names. PE pathname reproduces; artifact failure is classified as environment-dependent inherited timer interference, with inference/limits recorded below. |
| Defense source unit diagnostic |Prepared source run264 pass,8 original native skips,29 files/37 suite records; hardened IPC run repeats264/0/8 after inert adversarial finding; initial receipts retained. Direct source build passes. Initial failure retained: local TSX IPC refused and ignored dist missing. Canonical native generation remains unrun. |

The full native-coupled Core/Workspace/Intel test commands and full turbo gate
are not claimed as executed. The retained PR2406 audited owner checks cover
Core798/48 suites, Workspace90/4 and Strategy101/9; this supplement independently
rechecks the formatter-affected owners. The source-only applicability audit uses
the original published Cleanup discovery predicates and exact YAML run parsing;
thirteen test-bearing packages have supported runner classifications. Neither
discovery nor partial source results are full-workspace release acceptance.

The original Cleanup2392 tooling was checked separately, without native gate
execution: configuration34/34, pinned-visual51/51, render-context19/19,
standalone discovery10/10 and baseline controls10/10 pass. Its historical coverage
floor verifier passes against its unchanged baseline; it is not the current RC's
baseline. Test-proof fixtures49/51 pass; the two failures are environment-dependent
because installed pnpm11.25.0 attempts installation then fails creating its
external store before the fake runner's JSON exists. Source pins pnpm9.12.0.
No option/store/permission/native-download workaround was applied.

## Failures retained and classified

- Composition/changed-file formatting: initial scope49 failures versus48 on
  main. The new saved Workspace helper supplied one new failure; the shared index
  already had baseline debt but was touched by composition. Only these two files
  were formatted, independently reviewed and committed. The remaining47 files
  are byte-identical to main; whole formatting remains red.
- Existing Web baseline: lowercase PE pathname fails on both candidate and exact main. The artifact DOCX test saw a prior saved-PDF URL revocation in the full candidate run but passed two focused main runs and the full main run. Exact unchanged baseline timer statement was extracted and probed inertly: deferred callback resolves the later URL.revokeObjectURL spy and passes blob:saved-pdf. Candidate file32.24s exceeds its30s delay; main full1.74s does not. Classification is environment-dependent inherited timer interference; causal attribution is an inference, not a reproduced original assertion on main. Original candidate failure stays red. No test/cleanup/product edit was made.
- Existing baseline: Meri catalog expects138 while actual catalog has139. Exact
  unchanged catalog/spec source and a focused main reproduction retain the
  failure. No registry entry or assertion was changed.
- Environment: Intel/Onboard custom Prisma declarations initially absent; source
  and configs are unchanged from main. Official WASM/no-engine generation resolves
  the compiler cascades. Native generation still remains unaccepted.
- Environment/launcher: the first Program Element static script launch used a
  missing root TSX link. Its raw failure remains; the existing installed API TSX
  launcher runs the unchanged script successfully.
- Environment/tooling: original Cleanup test-proof fixtures fail before leaf
  reports because of the installed package-manager/store behavior described above.
- Evidence correction: an initial API command regex matched api-strategy; a text
  scan counted a comment-only context reference. Both intermediate receipts remain.
  The independent parsed-YAML audit is authoritative. Reference-fixture metadata
  originally declared the RC instead of the actual2392 source; that original
  declaration is retained alongside the explicit correction, with raw bytes unchanged.
- Review receipt correction: the first independent source hash receipt trimmed
  final newlines. Failed and corrected full-Git-byte receipts remain together.
- Evidence-reader environment: first verifier exceeded Node's default1MiB Git-output buffer on the full Web JSON receipt. Original failure is retained; only the read-only reader buffer increased to64MiB. All hash/source assertions remain unchanged and242-file published verification passed.
- Whole staged whitespace may report formatting inside original raw test logs;
  raw output bytes are preserved. Authored source/docs are checked separately.

The read-only CLI inventory contains881 subjects:468 entrypoints,112 declared
non-smoke operands,160 tests,15 modules,120 conservative static unsafe labels
and6 missing declared scripts. The six missing references are identical on main.
450 entrypoints lack a derivable no-arguments contract; all are inherited, and
three older unknowns are now resolved by published facility/calendar/migration
guards. Static labels are not executed side effects, and a source contract cannot
replace the original contained v5 smoke/syscall/raw-audit proof.

[GATE-MATRIX.json](GATE-MATRIX.json) keeps all eleven original §10 criteria open.
The finite source carrier, CI and coverage gaps are listed in
[BLOCKERS.json](BLOCKERS.json). Python frozen dev tools are absent; no uv sync or
package installation was performed. Native PostgreSQL roles/RLS/constraints/
cascades/triggers/MVCC/locks, migration application, known client/grant lock-order
qualification, actual calendar refresh and designated account/frontend acceptance
remain outside this execution's source-only scope.

The diagnostic preloads cover the named Node APIs used by these audited source tests. They are not OS isolation or original v5 syscall-audited containment, and do not prove refusal of arbitrary direct native/child-process/dgram calls. Review found that the initial IPC allowance forwarded mutable/getter options; an inert probe demonstrated a possible TCP-shaped delegate without any socket execution. Original bytes/red receipt remain, the hardened harness binds fresh immutable path-only arguments and rejects getters/proxies/mixed options, and a separately named Defense run again passes264/0/8. The original release guard was never changed.
