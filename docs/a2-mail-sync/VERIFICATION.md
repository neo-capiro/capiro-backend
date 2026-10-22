# A2 ML-13: preserve mailbox reconnect holds

Base: `ca4de503fb6ec09caf0daf8b976a0f649c6b9665` (`backend-import`). This is the first bounded A2 Core increment, not full A2 or mail acceptance. No schema, migration, manifest, lockfile, shared registry, runtime, proxy or frontend changes.

## Behavior and ownership

Google invalid-grant and Microsoft interactive-consent failures already marked the connection for reconnect, but their top-level sync catches replaced that hold with `error` and a retry hint. The token owners now throw a typed reconnect error only after their existing token-fingerprint/current-member fence durably records `needs_configuration`. Both sync owners preserve that recorded outcome. Missing refresh material, Microsoft missing identity and returned identity/scope mismatch follow the same hold policy.

The small domain-owned `mail-sync-failure.ts` centralizes status, safe diagnosis and retry timing. Permission failures and Exchange-mailbox absence stay held; transient errors keep the existing 15-minute retry. Generic failure writes condition on the current row still being `connected` or `error`; a concurrent hold, disable or deletion is preserved. Requested scopes, transport mutation replay behavior, existing OAuth ownership and the scheduler's connected/error admission are unchanged. Raw provider diagnostics are omitted from the persisted failure notice.

The existing provider service files are large inherited owners. This change reduces duplicated failure transition code and adds no new domain responsibilities, dependency cycles or external effects. The new helper is 34 lines and the test groups cover only this transition boundary. Independent review must assess these existing-owner edits; file-size limits are not waived.

## Source evidence

- 28 new source tests exercise real top-level provider sync and real token-authority logic with fake provider exchanges and in-memory transaction seams. Cases include both invalid grants, repeat redemption refusal, missing refresh material, transient retry/recovery, existing OAuth callback reconnect, failed hold persistence, late failure after hold/disable/delete, permission denial, scheduler predicate exclusion/re-enable, Google quota 403, Exchange mailbox absence, structured Microsoft consent codes, and Microsoft missing/mismatched identity/scopes.
- 73 existing source tests pass across A1 OAuth, both transport retry suites, Google quota budget and scheduler behavior. No provider calls or database startup occur.
- Focused TypeScript compilation of the new suite and its transitive source closure passes using the repository's strict options and local `@capiro/shared` source. This is not the full backend multi-project typecheck.
- Eight controlled source mutations were killed by assertion failures. Swallowing the top-level error independently kills all 11 Google and 17 Microsoft cases (all 28 new cases covered). Additional mutations prove terminal status, absence of retry hints, preservation of held states, structured consent codes and transient Google quota classification. No compiler/import failure counts as a killed mutant.
- Restoring the three changed pre-existing production files to the exact base makes four focused invalid-grant/permission tests fail on the expected state mismatch (`error` plus retry instead of `needs_configuration` with no retry). Restoring the fix returns them to green.
- `git diff --check` passes. Synthetic fixture identifiers and `.invalid` addresses only; final publication diff inspected.

The source-only runner is `node apps/api/node_modules/jest/bin/jest.js --config docs/a2-mail-sync/jest.config.cjs --runInBand`; focused typecheck is `node node_modules/typescript/bin/tsc -p docs/a2-mail-sync/tsconfig.json`. Mutation results are recorded in [mutations.json](mutations.json). The host reused existing dependencies through ignored local junctions: Node 24.22.1, Jest 29.7.0, ts-jest 29.4.12, TypeScript 5.9.3, Prisma client 5.22.0, Nest common 10.4.22 and MSAL 2.16.3. No package installation or generated-client changes were made. The exact locked install remains a separate gate.

## Held gates and remaining scope

Linux image/build, exact pinned install/full typecheck/lint, PostgreSQL 16 execution/locking, AWS/CodeBuild and authorized provider/live acceptance are Fable-run and are not claimed PASS. The scheduler test inspects its real SQL admission at a mocked persistence boundary; it does not prove native SQL locking.

ML-12 grant/capability diagnostics, ML-14 per-resource health, ML-15 subscription recovery, ML-16 durable whole-sync claims/stale success or cursor fencing and ML-17 UI/history semantics remain separate work. Existing partial-success behavior after a transient mail leg is preserved. A failed attempt to persist a reconnect hold is surfaced as an error, not a durable-held claim. No frontend timeline, provider activation, deployment or live acceptance is included. Acceptance remains STOPPED 2/6.
