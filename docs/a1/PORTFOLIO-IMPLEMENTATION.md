# A1 Portfolio implementation and verification

Base: backend-import 8d9958f75ba2fefe8edcf5e21a459ae97187ac8a. Frontend main 24316f913e6082cf33fb0049c1187dc64097975f. Draft-only work; no features enabled, migrations applied, merge or deployment.

- PF-10: domain admission reuses active tenant membership and existing client wall. Four ordinary meeting reads and shared/library feeds reject removed members, archived/hidden clients and stale selected-client associations. Unassigned owner reads remain supported; shared feeds retain tenant-team policy within the current wall. No Core auth/session changes.
- PF-11: ordinary meeting edits preserve unchanged association provenance, including internal status. Real reassignment requires a reviewed updatedAt token and current source/target visibility. The existing lock, child propagation, private-reset and attachment reindex flow remains canonical.
- PF-12: one versioned metadata projection for notes/debriefs, exact reads and receipts; current role governs actor visibility and available actions. Historical approval details remain explicitly unknown. Nullable debrief approval fields require Fable to number/apply the accompanying SQL proposal before deployment.
- PF-22 (directly approved by Neo on 2026-10-21): completion/reopening is based on recorded commitment/request kind, independent of optional due date. Other kinds reject completion. Title/body updates continue preserving recorded metadata. Rich metadata editing remains a separate contract as requested by the ticket; no due-day or Objective reassociation endpoint is introduced here.

## Verification

Focused final backend run: 25/25 passed (four new A1 tests and 21 existing meeting-client-reassignment cases). The real EngagementController HTTP fixture exercises hidden-client refusals on meeting, notes, debriefs and library, moved selected-client refusals, and an allowed owner/unassigned read. It uses the actual service and role guard with a fixture authenticated context and transaction database; it does not qualify credential/session middleware or PostgreSQL RLS.

Focused final frontend run: 33/33 passed (three new A1 tests and 30 existing activity-change cases). The new tests cover saved-association omission/revision, nullable/unavailable metadata and current capability refusal, and kind-based activity dispatch. Existing malformed-receipt and stale-read checks remain in the regression suite.

Each of the seven new tests was mutation-checked. Restoring the original backend service and activity service from the base commit makes all four A1 tests fail behaviorally: hidden parent is admitted, unchanged assignment writes twice, lifecycle metadata disappears, and an undated obligation is refused. Restoring the repaired files passes. Three targeted frontend mutants each fail the corresponding test: unchanged clientId is sent, sharingKnown is stripped, and dueAt controls completion. No mutant remains in the source.

The PF-12 test exercises both note and debrief create → approve → share → exact reread → shared-feed reread → unshare → reread, then verifies current-role downgrade redaction. The PF-11 test covers the ordinary save and explicit override routes, including no-op audit suppression and required/current revision. The service negatives separately cover same-tenant wrong owner and foreign tenant, and refuse before child reads/decryption/writes.

Prisma schema validation passes. TypeScript transpileModule reports zero syntax errors across all 19 changed TS/TSX files. These are not type-check or build results.

The focused harness uses the available cached Jest 29/ts-jest, Vitest 2.1.9, and the cached Zod 3.25.76 package's v4 subpath. The checked-in focused config resolves pretty-format alongside Jest's matcher utilities; the cached qualification used 29.7.0 because the overlay root carries 27.5.1. Unused heavyweight constructor dependencies and the unused throttle decorator are inert; admission, ACL, metadata, write and receipt logic remain real. The frontend civil-day helper throws if used in the new tests because Temporal is unavailable and those cases do not exercise due-day conversion. No shared dependency cache was changed.

Raw green/red reports and syntax/schema outputs are retained in `docs/a1/evidence/`. The backend focused runner and inert import fixture are checked in as `docs/a1/jest.portfolio.config.cjs` and `docs/a1/portfolio-test-dependencies.cjs`. Original local mutation scripts remain in the task's `portfolio-evidence` directory. The repository's full pinned dependency gates still apply.

## Reproduce the focused backend run

After installing the repository's pinned dependencies, run from the repository root:

```sh
NODE_OPTIONS=--max-old-space-size=1024 pnpm --filter @capiro/api exec jest --config ../../docs/a1/jest.portfolio.config.cjs --runInBand --forceExit
```

The configuration selects only the two Portfolio suites (25 tests), omits the normal worker/database setup, and loads the explicit inert import fixture. It derives all repository and dependency paths at runtime; no `/tmp` configuration or task-specific absolute path is required. `diagnostics: false` and isolated TS transformation are deliberate: this command verifies runtime behavior, while the generated-client/type-check gate remains separate. The fixture does not mock the resource authority, client wall, encrypted-entry ACL, metadata projection, tested mutations or real controller role guard.

The checked-in configuration was also exercised against the same cached dependency overlay used for the original qualification. This does not claim a new exact-pinned dependency build.

Read-only integration comparison before Mail was appended: backend `29fba43de66a5efb7c1552f82ae12d48435dd912` has the same tree as Portfolio `b61c12f9b3c5fe9b37260f458a37cb8095627d08`; frontend `fad175aff4d93dbf6f6e572226928b080e35fa07` has the same tree as Portfolio `db971acd8757fa78302d877faab2ab6aac420276`. Later Mail integration needs its own final combined verification.

## Explicit release holds

- Fable must number and apply `PF-12-unnumbered-migration.sql`; no database was changed. Existing approved debriefs retain unknown approval details rather than fabricated backfills.
- Generate the Prisma client against the migrated schema in an isolated output and run the full type/build gates. The available generated client predates the new fields; no casts conceal the new schema requirements.
- Exact-pinned frontend/backend builds, real PostgreSQL/RLS/transaction concurrency, native session/impersonation qualification and browser pending-scope/reload checks remain unrun. The fixture tests do not replace those gates.
- The four Portfolio routes and relevant feature activation remain held for ordinary staging qualification. No feature flags were enabled, deployment performed or PR merged.
- PF-22 rich metadata editing, due-day/timezone edits and Objective reassociation remain the separate contract allocated by the ticket; this lane preserves metadata and fixes settle/reopen eligibility only.


Neo directly approved the non-email PF-22 kind-based completion rule on 2026-10-21 (relay recorded in meri-greenfield #202, comment 6328397030). Commitments and requests may complete/reopen without a due date. This does not authorize activation or the pending Mail policy proposals. Portfolio artifact approvals remain unchanged by the separate Workspace removal decision.

## Review revision

The strict-index tuple error in the PF-12 spec is corrected. The three legacy meeting/artifact suites now provide active Clerk-bound membership, transaction helpers and complete timestamps while preserving all prior assertions and test names. The restored 60/60 focused receipt and the canonical-run missing-dependency blocker are recorded in `evidence/review-r1-legacy-fixtures.json`. The proposed PF-12 foreign key uses `NOT VALID` followed by a separate validation statement; no SQL was executed. Deployment order remains separately authorized migrations → backend → frontend.
