# Objective admission-read source slice

Base: `b40971b1f8de888687a8fb92fbdf4ff653fe10d3` (PR86).

This slice supplies only Core's tenant-transaction adapter for the existing
`admission-read` decision kernel. It stays unmounted and disabled by default.
It does not issue a token, consume a caller proof, resolve global tenant scope,
return an acceptance/absence result, or modify the production runtime.

## Implementation outline

- Own only `objective-workload-admission-read-source.ts`, its focused test, and
  this note. Reuse `decideObjectiveLaterCurrentWithinTx` for domain decisions.
- Read the original job under its lock, then the private deterministic admission
  resource, current native actor/membership/client visibility and original
  immutable consent association, then the delegation and database clock.
- The Strategy ledger reference is `objective-canonical-producer-ledger.ts`
  (`readGenerationLedger`, lines 17–23) and its admission data is defined by
  `objective-canonical-generation.ts` (lines 74–84). No cross-application
  implementation import or shared contract change is introduced.
- Consent remains the original admission's consent. Historical read authority
  does not renew effect consent or require the objective's current revision to
  equal its historical admission. Current membership, client wall, feature flag,
  objective existence and unrevoked delegation remain mandatory.
- A supplied transaction belongs to the caller. No connection, transaction,
  signing key, network request, migration or grant is created by this module.
- Focused validation covers exact private resource custody, original consent
  linkage, tenant predicates/lock order, malformed rows, revocation, historical
  reads after effect expiry, unsupported phases, disabled zero-I/O and SQL
  fault propagation. Offline fixtures do not qualify database privileges.

D29 remains open: the relay issue/release wire, authenticated original Meri run,
remaining phase adapters, durable issue/release composition and runtime bindings
are still absent. `CHECK(enabled=false)` and the production `/decisions` mount
are unchanged. This source slice must not be published as enabled authority.

## Focused evidence

- `node --test --test-reporter=dot
  apps/api/src/auth/workload-authority/objective-workload-admission-read-source.focused.test.mjs
  apps/api/src/auth/workload-authority/objective-workload-later-current.focused.test.mjs`:
  39 tests passed. The new fixture executes the adapter SQL in PGlite memory.
- Strict, no-emit TypeScript for the adapter and its current/later-current
  dependencies, with `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`: zero diagnostics.
- Initial focused run: all behavioral and SQL-denial cases passed, but the
  table-order assertion's regex matched `EXTRACT(... FROM deadline_at)`.
  Anchoring the extractor to a SQL `FROM` line repaired that test. The rerun
  above includes the unchanged lock-order and behavioral assertions.
- No live database, AWS call, broad suite or credential operation was run.
  Runtime role permissions, RLS and lock concurrency still need their own
  qualification. In particular, this reader's `FOR SHARE` on private resource
  and consent rows is not evidence that the runtime has the required grants.
- Independent read-only review found no material blocker in this source-only
  slice. It confirmed tenant predicates, original consent/actor/membership and
  control linkage, private admission custody, phase exclusion and read-only
  behavior after effect expiry. Future issuance composition remains unqualified.
