# Core/Meri Objective composition and required contract decision

Source baseline: Core `eef7cd1b874549bc2115b313ebb00fe83e2e57da` (draft PR61).
Meri owner-confirmed baseline: draft PR121
`0d6ba1590b41e3bc911e8c50f7c7407632101832`, based on PR114 `7ef7c61`.
This increment changes no public Objective DTO, SQL, transaction implementation,
Meri source, bootstrap, general auth/session middleware or shipping recipe.

## Callable Core source completed in this increment

The actual `ClientsModule -> ObjectiveWorkModule` graph now imports
`ObjectiveWorkloadAdmissionModule`. Its fixed
`POST /api/internal/objective-workload-authority/decisions` controller calls the
new runtime and returns a closed 503 with `Cache-Control: no-store`.
The production provider calls `createObjectiveAdmissionRuntime()` with no
arguments: it is **hard-disabled**, has no environment switch and reads no
Prisma, caller keys, signer keys or clock. Source route registration does not
establish positive authority or activation.

An explicit trusted composition can supply the existing server-owned Prisma,
named caller pins, signer owner and policy digest. The runtime then constructs
the actual `createPrismaObjectiveAdmissionSource`,
`createPrismaObjectiveIssuancePort` and `createObjectiveAdmissionIngress`.
Their original locked current-source, durable proof/decision/JTI/delivery and
retry behavior is unchanged. The historical delegation `CHECK(enabled=false)`
still prevents positive production issuance. This is an **admit-only** path.

The HTTP adapter preserves original method/URL and captured entity bytes,
checks duplicate Authorization fields against `rawHeaders`, and never
serializes `request.body`. Current API bootstrap does not capture `rawBody` for
this route. Missing capture therefore stays unavailable; allocation of a
bounded parser before JSON parsing is an additional prerequisite to any future
positive provider binding. No bootstrap or middleware change is hidden here.

## Map to existing owners

| Responsibility | Existing implementation | Actual integration state |
| --- | --- | --- |
| Core caller authentication | `objective-workload-proof.ts` | RS256, named pins, exact raw issuer request, 30-second bound; no authority by itself. |
| Core admission source and issuance | `objective-workload-admission-source.ts`, `objective-workload-issuance-prisma.ts`, `objective-workload-issuance.ts` | Real audited routing/current loader and durable issuance are composed by the new runtime. Production provider and DB delegation remain disabled. |
| Later native current authority | `objective-workload-later-current.ts` | Decision kernel exists, but no production adapter supplies its native readers. Admit port rejects later phases. |
| Strategy authority | `apps/api-strategy/src/planner/objective-canonical-authority.ts` | All five methods remain unavailable. A JWT verification helper cannot replace native actor/consent/delegation/claim checks. |
| Canonical publication | `objective-canonical-request.service.ts` | Requires genuine delegation reference/revision/issuance time/absolute expiry. Preacceptance facts omit required metadata; consent/control numbers are not a delegation revision. |
| Meri protected facts | `apps/runtime/prepared-run-issuance.mjs`, `prepared-run-bindings.mjs` | Genuine compiler emits no `objectiveGeneration` or `objectiveStrategy`. Isolated reader fixtures do not repair normal production issuance. |
| Meri accepted request and ISSUED receipt | `apps/control/conversations/postgres-store.mjs`, `apps/runtime/prepared-run-issuance-postgres.mjs` | Durable accepted request/full binding and immutable ISSUED metadata/digest exist. No job/admission-to-full-binding lookup or stored protected Objective projection exists. |
| Meri prepared/query readers | `apps/runtime/objective-generation/prepared-facts-reader.mjs`, `query-selection-reader.mjs` | Strict source factories exist but are not production-composed. Prepared read requires active/unexpired original issuance and genuine Objective facts. |
| Meri completion custody | `retained-result.mjs`, `core-result-owner.mjs`, `native-authority/remote-composition.mjs` | Retained factories verify published completion/object bytes/current access, but production composition omits the Objective prepared reader. No mounted retained HTTP reader exists. |
| Core retained HTTP bridge | `apps/api-strategy/src/meri/objective-canonical-result-owner.ts` and retained transport helpers | Strict bridge/factory source exists. Planner module deliberately constructs the closed owner without it; no compatible live custody reader or retained issuer is bound. |

All Core paths in the table are under `apps/api/src/auth/workload-authority/`
unless otherwise qualified; Strategy/Meri service names are resolved in their
respective owner repositories. Meri runtime first-chat transport/proxy work and
its distinct Temporal signer are outside this allocation.

## Genuine missing contracts and recommendation

The Meri owner reconfirmed the following at the exact PR121 pin; the independent
source audit found the same boundaries. These are **missing/unallocated source
contracts**, not a failed deployment or an invitation to substitute caller JSON.

1. **Protected issuance and custody.** Meri must validate the Objective pair in
   its normal fact compiler **before** immutable `bindFacts`, then retain an
   immutable job/admission-to-seven-field-binding mapping created from the
   canonical accepted request plus exactly already-ISSUED facts. The complete
   binding is `tenantId, actorId, conversationId, runId, attemptId, workerId,
   writerFence`. Core publication and caller binding remain comparators only.
   Missing, conflicting or uncertain custody must stay unavailable.
2. **Active and historical projections.** The proposed accepted-source lookup
   is not implemented. Its future closed nonsecret result must carry validated
   accepted request, immutable issuance/protected Objective facts and exact
   whole-facts/request/context hashes with checked-at/expiry. Historical
   retained custody needs a separate bounded metadata read with fresh authority:
   `preparedFacts.read` only accepts active runs and `readIssuance` is clipped
   to the original receipt expiry. Never serialize `resolveFacts()`; its result
   contains secret-bearing proxy configuration.
3. **Versioned signed-reader wire.** Meri's existing strict retained reader is
   EdDSA/Ed25519 with closed claims
   `{iss,sub,aud,iat,nbf,exp,jti,objective:{operation,phase,method,path,query,bodySha256,sourceSha256,generationJobId}}`.
   Historical Core signs flat RS256 claims with additional native selectors.
   They differ in schema as well as algorithm. Core's retained JWT helper has
   no durable later-phase issuer behind it. Meri's new Temporal RS256 protocol
   has a different purpose, keys and routes and is not an Objective substitute.

**Recommended minimal compatible decision:** allocate a distinct, explicitly
versioned Objective reader protocol using the existing Meri Ed25519 trust
direction and closed nested request binding. Allocate the genuine Meri
fact/custody/projection owner first; pair it with a dedicated Core
signer/decoder and later native-current/issuance adapter. Preserve historical
Core RS256 and the existing Meri strict gate rather than silently widening
either. Give the new purpose separate issuer/audience/key pins and fix its
closed request/response schema jointly before either owner implements a mount.
This recommendation does not choose live keys, URLs or activation settings.

Alternative: explicitly select a new RS256 Objective version and revise both
reader schemas/verifiers together. That changes Meri's existing trust contract
and still requires the same genuine facts, custody, currentness and durable
idempotency work. An algorithm-only adapter or dual-accept fallback cannot
close these dependencies.

Pending parent allocation/contract selection, no accepted-source decoder,
positive Strategy authority adapter or retained signer is invented here.
The Core admission composition and qualified v2 intake remain useful independent
source progress. Reserved jobs and full browser-independent Strategy execution
remain closed.

## Focused evidence and preserved qualification

Reproduce with existing read-only dependencies; no install or database:

```powershell
node apps/api/node_modules/jest/bin/jest.js --config docs/objective-strategy-core-20261017/qualification/composition.jest.cjs --runInBand
node apps/api/node_modules/typescript/bin/tsc -p docs/objective-strategy-core-20261017/qualification/composition.tsconfig.json --noEmit
git diff --check
```

The seven focused suites passed **116/116**; scoped strict TypeScript exited 0.
The actual Nest module/HTTP route is checked default-off. Positive admit
composition uses actual production factories, current-facts loader, signer and
verifier over explicitly synthetic native rows/transactions and fixture RSA
keys. Its enabled fixture rows cannot exist under the production migration's
disabled-delegation constraint. These tests prove source composition, denial
and retry behavior, not positive database or live authority.

The earlier exact `eef7cd1b` isolated PostgreSQL run
`1d28b3384cae4e43a0a1c7646a3bd6b9` remains **39/39**, including 38 native cases.
Its production transaction implementation is unchanged at this successor; no SQL
or transaction implementation changed and no native suite was repeated.
Owned cluster/process/temporary credentials were already retired and the
unrelated host PostgreSQL service was preserved. Failed historical pins remain
recorded on PR58/PR60; this increment does not relabel their results.

No AWS, credentials, migration, deployment, live binding, frontend activation or
first-chat image/source pin changed.
