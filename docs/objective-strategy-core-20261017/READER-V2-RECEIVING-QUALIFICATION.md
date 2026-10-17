# Initial Strategy reader v2 receiving

Source successor to Core PR64 `806a0939267806e7481bb2bbfe260f5a5a0794c3`.
Two new receiving source/spec files adapt the frozen workload-only v2 source
observation to existing VerifiedGenerationAcceptance and the existing canonical
retained result bridge. Actual canonical admission, publication, acceptance and
retained receipt validators are reused; normalization and atomic write owners
remain unchanged. No provider, route or environment activation was added.

The native owner must independently authenticate and load the original stored
admission, job DTO, publication and acceptance on every before/after call,
including actual readCanonicalRequestPublication custody reconstruction.
An echoed publication or a matching digest does not supply that authority.
The real v2 credential client and genuine native owner are required ports and
are not supplied or enabled by this factory. Frozen v2 source is initial-only;
regeneration is explicitly refused rather than widening the protocol.

Node24.19: **28/28** focused Jest cases and scoped strict TypeScript exit0.
Positive cases compose the actual v2 client/JWT, canonical validators and
ObjectiveCanonicalResultOwner over explicitly synthetic native owner, HTTP
and process-local credential fixtures. Replay, source/type/prompt/DTO/binding
conflicts, expired historical execution, typed non-success receipts, native
revocation/expiry, cancellation and concurrent parser closures are covered.

Independent review reproduced an expired first-grant return and a final
microtask cancellation race in the initial 25-case source. Both were repaired:
the final complete clipped expiry is checked, and a final caller/internal
signal, monotonic clock and proof deadline check precedes release. Three
regressions were added. The initial source is not accepted as qualified.

Portable commands with Node24 and the existing locked dependencies:

```powershell
node apps/api/node_modules/jest/bin/jest.js --config docs/objective-strategy-core-20261017/qualification/reader-v2-receiving.jest.cjs --runInBand
node apps/api/node_modules/typescript/bin/tsc -p docs/objective-strategy-core-20261017/qualification/reader-v2-receiving.tsconfig.json --noEmit
```

This is source qualification with synthetic authority, not native/live
acceptance. Existing unavailable Strategy authority methods and production
delegation disabled constraint remain. No browser DTO, Meri source, SQL,
existing transaction, auth/session, first-chat pin, credentials, AWS, build,
deployment or activation changed. The original eef7cd1b PostgreSQL39/39 result
is preserved at its original source/run and was not repeated.
