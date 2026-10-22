# A1 review R1: OAuth Add and Mail fixture corrections

Scope: backend #106 review items 2 (Mail fixture portion) and 4. No ML-09 sync-policy change or new mail capability is included.

Both provider Add flows reuse only the actor/provider/tenant's newest fresh unbound placeholder. A transaction advisory lock serializes the empty lookup before creation, and each candidate is reread under its row lock. A token, prior cursor, sync history or retained message/meeting/thread history prevents reuse. Explicit reconnect retains its existing account binding. Starting again replaces the nonce, so an older callback cannot consume the latest attempt.

The legacy replay fixtures now identify the same syncing connection, and Gmail removal assertions include the connection argument. Existing manual-association and replay assertions are retained.

## Verification

- Four focused suites: 75/75 pass before mutation and again after restoration, including 10 new Add cases across Microsoft and Google.
- Five production mutations killed. Every new case fails under at least one relevant mutant: always-create, bypass freshness, omit candidate row lock, omit Add serialization, and reverse newest ordering.
- Sources restored byte-for-byte after the mutations; the helper SHA and failed test names are in `review-r1-add-reuse-mutations.json`.
- The new concurrency test simulates transaction advisory-lock behavior at the query seam; it is not native PostgreSQL contention evidence. Providers and persistence are mocks, with real OAuth start/callback and admission functions executing.

Command from repository root:

```sh
node node_modules/jest/bin/jest.js --config docs/a1/mail/jest.config.cjs --runInBand --no-cache --runTestsByPath apps/api/src/engagement/mailbox-oauth.add-reuse.spec.ts apps/api/src/engagement/mailbox-oauth.a1.spec.ts apps/api/src/engagement/mail-replay-preservation.spec.ts apps/api/src/engagement/mail-unassociated-capture.spec.ts
```

## Canonical gate still required

The same existing suites were attempted with the unchanged repository `apps/api/jest.config.cjs`. Collection stops in `jest.native-runtime-environment.cjs` because the available dependency cache lacks `sanitize-html`; `@azure/msal-node` is also absent. The repository runner was not relaxed or stubbed. Focused evidence uses the previously disclosed cached Jest/ts-jest and docs config, not a clean locked install. Full canonical engagement base/head failing-name parity, full typecheck/build, real database locks/RLS and provider qualification remain unverified here. No dependency, schema or database was changed by this correction.
