# Independent executable CLI source and caller review

Accepted within this bounded source/caller scope:
`5db091dac54bc05f4a97a1495c8e6df238547c4d`, tree
`725acfb0db38db8b62e79b9f3fba7823d5b88bff`, against parent
`f1e83a3f194a8ebd972e370ff6e5b5f559888b29`. Reviewer import
`69c4e07aee9804b43c1fc56284ecdcf859e8b3a8` has the same tree.
The reviewer authored evidence only, in a separate worktree, and edited no
implementation/owner files. Earlier candidate heads and failed controls remain.

The review uses source differences, AST/literal comparisons, inspected caller
operands and inert execution traces. Published origin or annotation counts are
not acceptance evidence. Carrier/config/native acceptance remains separate.

## Evidence and semantic findings

`source-body-initial.json` pins all 450 manifest paths to exact Git source blobs
(449 selected published transitions plus the existing canonical Meri release CLI).
It compares 1,011 baseline SQL-like string/template projections with current
source: none are lost or changed except insignificant whitespace outside quoted
SQL text. The extra matched projection is the L2 help string beginning “With no
arguments”, not an added database query. This is static projection comparison,
not a PostgreSQL parser/runtime test.

The high-change source leads were inspected beyond these counters. Prisma clients
move into guarded lifetimes and are threaded into the same existing helpers;
existing SQL bodies, bound parameters, watermark selections and source-kind
drivers remain. Diagnostic `q` helpers move into the corresponding client's
lexical lifetime. Deferred imports preserve the same canonical writer/service
owners. Parser extraction and stricter unsupported-input refusals leave recognized
configured modes intact. The Phase 7 rehearsal failure marker is rethrown through
expected-refusal catches so cleanup cannot convert a rehearsal assertion into a
passing database-refusal control. `finally` closes constructed clients on failure.
These are inspected source semantics, without executing configured operations.

The strict parent `scopeIssues` function in the Phase 3 scope verifier is AST-body
identical; no exact-maintenance waiver/helper weakens its rules. All canonical
Meri non-CLI owner functions, including `parseArgs`, `releaseOperator` and receipt
persistence, remain AST-body identical to the parent. Only the active CLI's usage,
help and no-argument preflight changed. The retired legacy release executor was
not invoked or changed by this reviewer.

`inert-interop-final.json` contains **49 passing traces across 14 representative
subjects**. Ten explicitly guarded commands refuse no arguments and unsupported
arguments or return help before dependency/file/DB/provider/bootstrap/child effects.
Three diagnostic families retain configured no-argument behavior, return supported
help, and reject unknown arguments—including an inappropriate `--run`. Their
configured valid mode reaches only a fake Prisma-construction stop. Canonical Meri
no-args/help/invalid-action forms stop without resource effects.

The VM replaces imports with fake dependencies, resource APIs with throwing stop
markers and environment loading with a no-op. It strips the hashbang, rewrites
`import.meta.url` to the same source identity and models process termination so it
cannot fall through ordinary catches. No operational body, provider/bootstrap,
cloud, child command, native database, credential or browser was actually run.
These traces do not prove dependency initialization or native command acceptance.

## Caller fixes and preserved modes

Five dispatcher operands now supply flags proven by their actual callee guards:
`bootstrap-roles --run`, `prepopulate-all --run`, the two default directory imports
`--import`, and `verify-defense-budget-packages --verify`. Existing `$@` forwarding
and command cases remain. The Strategy seed entrypoint supplies its required
`--run`; the Meri fixture and canonical-checkpoint workflows supply their required
flags. Scheduling source in `infra/cdk/lib/ingestion-schedule.ts` is unchanged.

Phase 4/5 local callers retain their exact `--sha`/clean-tree modes and add `--run`
only to their now-guarded code-verifier child arrays. The Phase 5 verifier receives
the exact published preflight, while its original verification body remains.
Canonical Meri usage now advertises its existing **positional** action parser,
instead of an invalid `--action` form; no parser or release-policy rewrite occurred.

All **47** inspected root/Core/Strategy package flag additions preserve the entire
original command token sequence. Their actual callee dispositions differ:

- Explicitly guarded commands/helpers consume the required marker or offline mode.
- Existing configured diagnostic/sync commands retain their bare/default behavior.
- Unsafe-classified Templates DB, Phase 6/7 mutation controls, metadata-regression,
  Package 9 durable qualification and benchmark paths ignore the added `--run`
  marker, or select only their existing recognized options. Such tokens are
  compatibility markers, **not safety preflights**. Those runners were not invoked,
  expanded into smoke scope, or claimed as safely/native qualified here.

No broad unsupported-help expansion was requested or performed. CleanUp §6.2's
missing-DATABASE_URL smoke context and “help where supported” remain the boundary.
Ignored/archived `.env` and credentials remain excluded from the staged source
contract; a VM no-op dotenv does not establish behavior in a credentialed host.

## Corrected conjectures and preserved failures

Two initial caller conjectures were wrong and withdrawn before acceptance:
configured no-argument diagnostics do **not** require `--run` (they reject it), and
the original Phase 6 shell child remains valid because its unsafe-classified
mutation runner has no argv guard. Its shell invocation was restored byte-for-byte
to the parent. The genuine dispatcher and local-child findings above were verified
from their actual preconditions. No naming convention or annotation substitutes
for that proof.

Initial inert harness failures are retained in separate raw files. They concerned
synthetic catch-node generation, a hashbang inside the async VM wrapper, `.mjs`
transpilation retaining ESM syntax, and missing CommonJS default-import interop.
The final harness fixes only the probe adapter, not any candidate source. Original
Cleanup helper evidence was treated read-only and was not rewritten or rerun.

No blocking source/caller issue remains within this review. This is not full-gate,
CLI native smoke, migration/database/RLS, deployed scheduling, browser, provider,
cloud or release acceptance. The separate EngagementService reporting owner and
its branches/source were not inspected or altered.
