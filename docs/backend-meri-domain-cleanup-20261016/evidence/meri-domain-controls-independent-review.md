# Independent review: permanent Meri/Engagement cleanup controls

**No concrete issue found in the frozen permanent controls or the one-line catalog addition.** Review is limited to source semantics and test-claim accuracy. I did not launch Node, tests, parsers, a compiler or application processes, and made no production edits.

Reviewed `scripts/ci/meri-domain-cleanup.contract.spec.mjs` (SHA256 `5043be2a209a788f306b1a5dad221ad14a3db9e4aa0d7d244d5cb59cbe98eafd`) and the current catalog diff in `scripts/backend-source-qualification.mjs` (SHA256 `e63a3582ca6b12433490407dc370e7e32a3e498cadd7fae60a086c7e6bbe654c`). The parent receipt at `meri-domain-focused-controls.json` records 24 new plus 18 existing catalog cases, 42 passing, exit 0, PID 32676, start `2026-10-16T04:10:46.2613239Z`. That is an observed existing receipt, not a new execution by this reviewer.

## Fixture and execution boundaries are transparent

- Header lines 8–13 explicitly distinguish isolated real domain/input/bill-text modules from the decorated service classes, which are read as data. They expressly exclude native Nest/shared normalization, Prisma/SQL execution, DB behavior, application typing and native acceptance.
- Lines 30–47 visibly define the fixture exception and six shared ID/status functions. The fixture `currentCongress = 119`, deliberately narrow designation parser and `fixture-status:` label cannot reasonably be mistaken for actual shared implementations. Corresponding result assertions use those fixture labels explicitly.
- `bindImports:50–65` validates finite ownership, named imports and exact external names; it refuses dynamic/require, side-effect-only and unowned imports instead of silently deleting imports. Types are stripped from the three real isolated modules, and only those admitted imports are rebound.
- `facadeMethods:70–77` reads all five actual current private methods from `meri-tools.service.ts`, requires exactly one of each and the exact same-input/per-call delegate expression, then loads only those methods into a small plain facade. Neither large decorated service nor its Nest DI constructor executes. The real bill-text module has no fixture replacement for its paging/locator algorithms.
- Prisma and LDA ports are explicit spies. SQL tests establish literal query/binding/projection behavior, not SQL execution or database correctness. The control names and header preserve that distinction.

## Compatibility and meaningful counterexamples

- The domain construction case at 167–173 uses throwing proxy ports to detect eager dependency reads and separately permits undefined ports. It exercises the real isolated domain constructor.
- The actual-facade case at 380–390 covers the original plain-Prisma prototype CBO seam and replacing the receiver's Prisma dependency between calls. The five-handler error case at 401–413 reaches every real domain handler and every extracted actual facade, requiring the same error object to propagate without swallowing it. The source ownership check separately fixes each facade to its matching handler and unchanged raw input.
- Input controls cover trim/caps/required errors, invalid/finite numeric fallback, clamp/truncation and UUID v4 behavior. Frozen input objects are exercised across all five handlers.
- The ownership negative at 175–183 rejects wrong forwarded input, a copied validator, unowned imports, side-effect imports and require calls. Domain method/import ownership is finite and deliberate; unrelated god-service body text is not hashed or frozen.
- Behavior cases include LDA positional filters and fallback, actual bill-text paging projection and exact argument order, status absence/rule-failure honesty, member ambiguity/no-match no-query behavior, scoped cursor refusal before reads, stale/out-of-range continuation, surrogate-pair paging, located-text partial/no-match coverage, and explicit missing-CBO output. These are substantive bounded controls rather than tests that merely mirror extraction line counts.

## Engagement orphan proof has explicit local limits

`retiredRootsAbsent:418–424` checks visibility-declared methods and direct `this.name(...)`/literal-bracket invocations after its bounded comment stripping. Twelve negative additions cover the three names as private declarations, dot calls and both quote styles of bracket calls. The current positive and unrelated-comment positive prevent an old whole-file snapshot dependency.

This is **not** a TypeScript compiler, global call graph, dynamic/reflection proof or live retirement receipt, as the source comment at 416 states. It does not claim to detect computed aliases, every possible declaration syntax or external consumers. The original finite repository name/reference pass and one-time byte inverse remain separate evidence for the initial removal.

`retainedEngagementSeams:425–438` protects the current enrichment/public bill-truth/exported scrubber/gateway markers and at least seven direct native enrichment call sites. Its two counterexamples remove the bill-truth marker or enrichment call sites and must fail. It does not execute or independently prove the seven native case semantics; it does not replace those retained native tests. Native test identity and unchanged bytes were part of the one-time source review/proof, while these permanent controls intentionally allow unrelated later source changes.

## Catalog and one-time proof remain separated

The sole catalog addition at line 178 is the new source-contract test path with `--test --test-isolation=none`; the runner supplies its existing 128 MB heap, fixed argv ownership, serialized execution, timeout and nonzero/error/signal failure handling. `ROOT = path.resolve(here, '../..')` in the new test resolves from `scripts/ci` to the repository root.

The catalog continues to declare `current-backend-source-contracts-only`, Node24/builtin type stripping, and native/build/image/frontend/Onboard/platform scopes UNRUN. The new entry does not activate workflows, change packages, broaden preview authority or imply native acceptance.

The old source identity/hash inverse is correctly outside the permanent catalog: `docs/backend-meri-domain-cleanup-20261016/verify-source-transition.cjs:1` labels itself **explicit one-time transition evidence, never an evergreen CI gate**, and line 7 requires explicit `--run`. Its repaired receipt records exit 0 separately. No frozen whole-file hash or transition-manifest assertion was introduced into the permanent test file or current catalog entry.

Remaining qualification belongs to the root/shared queue: native application tests, real shared normalization/Nest behavior, typing, SQL/database behavior, startup and integration. None is claimed by this source-only review.
