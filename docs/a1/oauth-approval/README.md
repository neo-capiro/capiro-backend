# A1 ML-08 / ML-10 OAuth handover

Neo explicitly approved the scoped OAuth/token repair on 2026-10-21 with “i approve” after the approval-before-edit boundary was described. Root relayed that approval to the Mail and OAuth workers before protected implementation. This branch does not merge, deploy, enable flags, call a live provider, send mail, or change AWS configuration.

## Behavior

- Empty Connect creates a separate pending mailbox. An explicit connection ID reconnects only its same stable provider account. A fresh registered mailbox binds its expected email; a missing token on a mailbox with prior sync state or history cannot establish a different identity.
- Signed state binds tenant, current owner, provider, add/reconnect intent, expected stable account, token snapshot, nonce and expiry. Stored one-use attempts are admitted before code exchange and again before persistence. Removed membership, deleted mailbox, replaced attempt and changed credentials fail closed. Existing cursors and a refresh token survive only a same-account reconnect. Duplicate accounts are checked under transaction/advisory locking, without taking another owner's mailbox.
- Microsoft refresh uses an isolated MSAL cache per exchange and exact-account refresh-token selection. Returned account and scopes must match. Both providers recheck current connection, membership and token snapshot before returning cached credentials or persisting a provider result. Late results cannot overwrite a reconnect or a newer token. Transient `error` status permits recovery; `needs_configuration` and an unexpired OAuth attempt block token use.
- Google partial consent drops the unaccepted token instead of automatically revoking an account grant. The returned identity is checked before marking the local attempt insufficient.

## Changed protected source files

All paths below are relative to the backend root. Neo's approval covers the bounded OAuth/token edits:

- `apps/api/src/engagement/mailbox-oauth-authority.ts` (new shared connection/token authority helper).
- `apps/api/src/engagement/microsoft/microsoft-oauth.service.ts`.
- `apps/api/src/engagement/microsoft/microsoft-graph-sync.service.ts` (imports, MSAL construction and token refresh methods only; Mail's transport/persistence changes are separate).
- `apps/api/src/engagement/google/google-oauth.service.ts`.
- `apps/api/src/engagement/google/google-token.service.ts`.

No controller, Clerk/auth/session middleware, schema, numbered migration, Meri or runtime enablement files were modified by this worker. Tests added: `mailbox-oauth.a1.spec.ts`, `mailbox-oauth.a1.http.spec.ts`, and shared inert fixture `mailbox-oauth.a1-fixture.ts`. Existing Microsoft refresh-token and Google provider-contract specs were updated to the safe contract.

## Evidence and reproduction

`baseline.tap` records nine source-derived baseline cases: eight expected failures and one positive control. `reproduce.cjs` is the original baseline extraction harness, intended for backend base `8d9958f75ba2fefe8edcf5e21a459ae97187ac8a`; it is not the current production-suite runner. `recovery-red.txt` records the subsequently discovered connected-only recovery regression before its correction: one failing case and 48 passing cases. The dependency overlay's mismatched pretty-format version obscures that rejected-promise diagnostic; the failing source location is the transient-error recovery assertion.

`mutation-evidence.json` maps every one of 49 new cases to at least one killed relevant mutant. The first run covered 42 service cases against 17 mutants; the second covered six HTTP cases plus the recovery case against six mutants. The two runs overlap two mutant types. `mutation-check.cjs` restores all edited sources in `finally`, rejects surviving mutants and rejects any new case without a killed mutant. Its default mode reruns all 49 cases; optional `http` mode runs the seven later additions and their targeted mutants.

The HTTP cases exercise actual Nest controllers, DTO validation, role guards and services over a loopback server. They reject another mailbox owner on `/start`, revoked membership on `/callback`, and revoked membership on `/:connectionId/sync` before provider exchange or cached-token use. Google callback preserves the controller's error redirect contract; Microsoft returns 403. Authentication middleware and global runtime guards are outside this harness: it supplies their trusted tenant-context seam. Database transactions/provider exchanges and downstream sync providers are mocks. No live OAuth or send occurs.

Final result: six suites and 75 tests passed; `green-evidence.json` records their names and statuses. Focused suites ran sequentially with a 1024 MB heap:

```text
src/engagement/mailbox-oauth.a1.spec.ts
src/engagement/mailbox-oauth.a1.http.spec.ts
src/engagement/microsoft/microsoft-oauth.refresh-token.spec.ts
src/engagement/microsoft/microsoft-graph-sync.scopes.spec.ts
src/engagement/google/google-provider-contract.spec.ts
src/engagement/google/google-oauth.scope-validation.spec.ts
```

Use the repository Jest/TypeScript dependencies and its normal configuration, or the session's `mail-oauth-jest.config.cjs` dependency overlay. Example mutation command:

```text
node docs/a1/oauth-approval/mutation-check.cjs <path-to-jest.js> <jest-config.cjs> <evidence-output-directory>
```

## Qualification limits

No live provider, native PostgreSQL contention/RLS run, full repository build or full TypeScript typecheck was performed. Transaction row/advisory locks and snapshot fencing are implemented, while concurrency fixtures mock the transaction boundary. Old in-flight OAuth states deliberately fail closed and require restarting Connect. Pending/exchanging attempts expire after ten minutes; the user can restart immediately to replace an abandoned attempt. The existing sync error handler may still update local diagnostic status after a refused token admission; no token or provider access is permitted by these tests. Review/merge and deployment remain with the coordinating owner.
