# A1 ML-09 bounded collision correction

Neo directly approved the bounded hold-and-continue correction in the session. This changes the handling of a known mailbox collision, while retaining the identity guard, access checks and no-resend protections. It adds no send or recovery action and does not implement the deferred mailbox-qualified key migration.

## Implementation and ownership

- `engagement/mailbox-identity-mismatch.ts` defines one typed, fixed-message persistence failure. It has no provider, database or policy side effects.
- Existing identity guard sites in both provider persistence methods and `mail-message-state.ts` now throw that type. The same admission cases still refuse writes; connection-qualified write selectors are unchanged. Ambiguous missing-row/context failures retain generic classification as described below.
- Graph mail, Gmail backfill and Gmail incremental loops catch only the typed collision **after** the transaction promise rejects. They report a per-run `held` count, log fixed text with no identifiers or message content, and process subsequent provider references. This is count/log observability, not a durable quarantine record. Their existing cursor/continuation machinery advances normally.
- Other failures retain their earlier behavior. Generic errors, even an error with the same message text, and conditional-write races abort the run without advancing its cursor. Missing input context, an absent relation without a positively observed mismatch, and a missing result from the connection-qualified summary lookup also remain generic failures: absence is not positive mailbox-identity evidence. Existing provider-gone and quota handling are unchanged.
- Removal can encounter a late returned thread mismatch after its first attempted update. A missing summary row is instead ambiguous and aborts without cursor progress. The catch is outside the transaction, so that update rolls back before the reference is held. No removal/reassignment/write on the colliding rows commits.
- Both providers initialize and aggregate the additive `held` statistic. A repository-wide TypeScript search found no external `SyncStats` constructors or consumers. Loop fixtures seed historical state without `held`; the run produces fresh counts. Current-run aggregation defensively defaults absent counts to zero, but those historical-state fixtures do not directly exercise that fallback. Existing calendar stats consequently include `held: 0` through the shared per-provider stats shape.

The new test harness has one bounded responsibility: exercise the real provider loops and persistence/removal guards through controlled provider and transactional ports. Its transaction fixture restores state when the callback rejects; it does not claim to qualify PostgreSQL itself. The inherited provider methods remain their existing owners; this correction adds no parallel sync implementation or broad refactor.

## Behavior and mutation receipts

The canonical five-suite command under `apps/api/jest.config.cjs` stopped before collection because the local cached dependency closure lacks `sanitize-html`: **five suites failed to start, zero tests ran**. No test-environment or dependency change was made to hide that failure.

The existing `docs/a1/mail/jest.config.cjs` focused harness subsequently passed:

- **87/87 tests, five suites**: 48 new provider-loop cases plus the existing mailbox-persistence, message-removal, replay-preservation and unassociated-capture cases.
- **123/123 tests, fifteen further existing Graph/Gmail sync suites**: cursor resets, history, quota bounds, provider retries, body handling, scopes and other sync regressions.
- These sets are disjoint: **210/210 tests across twenty suites**. This is scoped behavioral evidence, not full canonical API baseline/head parity.

The 48 new cases cover NULL and other-connection message/thread lineage, thread-only collisions, removal, late-removal rollback, missing initial relations and summary rows, a subsequent valid message, finite held counts when a run starts with historical state, cursor progress, exact redacted warning text, generic same-text errors, and conditional-write race refusal. Assertions verify old rows remain byte-for-byte equivalent, only the subsequent message/thread writes commit, contact harvesting occurs only for that valid message, and rollback is observed before the hold warning.

**Eleven of eleven behavioral mutants were killed by test assertions**, with all 65 selected tests collecting in each run. Mutants removed each loop's typed handling, broadened handling to generic errors, removed identity guards, let a late removal mismatch commit, or misclassified missing relations/summary rows as positive collisions. All mutated production files were restored byte-exact; before/after SHA-256 receipts are in the accompanying JSON. The restored files match the source used for the passing behavioral runs.

The focused harness uses the existing cached dependencies, transpile-only ts-jest, source mappings and its existing MSAL constructor blocker. It does not establish the canonical SDK/environment or a clean locked installation. Full raw local receipts use `/dev/shm/a1-r2-mailcollision-*`; the durable compact receipt is `review-r2-mailbox-collision.json`.

## Type diagnostics and remaining limits

A bounded strict compiler comparison used the actual `apps/api/tsconfig.json` options with the three changed existing production files as baseline roots, then the five changed production/test roots at the corrected head. Baseline source was supplied byte-exact from local HEAD `35fef48c`; real transitive imports were resolved in both runs. Both produced three diagnostics from the incomplete local dependency closure. The only diagnostic on a changed source file was the identical pre-existing missing `@azure/msal-node` declaration; **zero new changed-source diagnostics** occurred, including in the new tests. TypeScript version, complete diagnostics and method are in the JSON. This is not full-project or clean-install typecheck qualification. An earlier broad run was superseded by the classification correction and interrupted with exit130; no pass is claimed for it. Syntax checks and `git diff --check` pass.

Native PostgreSQL transaction/locking/contention, real providers and deployment remain unqualified. `held` is a per-run count/log, not a durable quarantine; the existing mail coverage helper does not promote it into a separate coverage status. The mailbox-qualified key migration and any downstream reconciliation trusting lineage remain deferred. No new dependencies, SQL execution, cross-lane changes, commits, merges or deployments were performed by this correction task.
