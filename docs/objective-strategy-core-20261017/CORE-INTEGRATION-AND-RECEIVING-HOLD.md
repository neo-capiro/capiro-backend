# Core Objective integration and receiving hold

This Core-only successor starts at PR66
`49f328eb8fbf797a38e9a5dc3df254eb652daa39`, tree
`371466cded927b976d91d846d1b2e7768a891c9e`. It preserves the public contracts
from PR53, PR56 and PR61. Meri is sealed at PR129
`047526c7022d04af6fd0f8faaae011171ef1eca2`; this change adds no Meri source.

## Reconciled browser and Core contracts

The source comparison uses frontend PR80
`de59687eb0067b19cc4ff2ffceddb19419ae9d8e` and integrated PR82
`36e6b70b9c086ba46bf24568865c50ba3a455ca9`, tree
`0d6e9fb3c3448950df5bd338b4d3802b7977975f`.

| Surface | Core ownership and receiving state |
| --- | --- |
| GET `/clients/:clientId/objectives/:objectiveId/generation` | Already mounted by ClientsModule / ObjectiveWorkModule. PR53 requested versus accounted source and command CAS remain unchanged. |
| GET `/clients/:clientId/objectives/:objectiveId/generation/outputs` | Already mounted. PR56 current ACL-qualified Planner project selector and creation versus retained application contracts remain unchanged. Core accepts exact verified source ancestry; the browser receiver remains current-requested-source-only. |
| POST `/clients/:clientId/objectives/:objectiveId/generation/strategy-commands` | Already mounted. PR61 closed v2 selection and exact receipt recovery match PR80/82. No new action or type inference is added. |
| POST `.../generation/commands` and `.../generation/confirm-pair` | Already mounted; the audited frontend pins do not register governed calls for these operations. |
| Current Planner navigation | Frontend rechecks both governed GETs, then ordinary active-client/current-project Planner access. No private operation, run, consent or workload selector is exposed. |
| Serving | Frontend flags remain false and preview routing omits the governed operations. Source compatibility does not establish a coherent deployed backend or browser qualification. |

## Core changes

Exact saved Strategy receipt replay now captures its strict selection in a
trusted `recovery-read` mode before the read-only lookup. The service derives
that mode from its transaction path. A miss re-enters the ordinary `write`
mode, which retains write enablement, duration, native owner, proof, CAS and
write fences. A disabled write flag cannot strand a previously accepted receipt;
it still prevents a new write. Changed selections remain conflicts.

The new Prisma native reader authenticates through a distinct genuine base
authority or fresh retained-access owner before opening a bounded tenant
transaction. It locks the original job, reconstructs the actual immutable
admission, original DTO and publication through the existing ledger owner,
and compares the stored acceptance. It repeats custody reconstruction and
native current membership/client wall/Objective checks before release. Native
proof, database time, monotonic operation deadline, cancellation and clipped
expiry are checked through actual transaction completion. Historical result
access preserves expired execution evidence and requires fresh read authority.
The read does not create admission, claims, consent, publication or execution.

PlannerModule now shares one explicit receiving runtime between its canonical
authority and result owner. Its production factory calls with no arguments and
stays closed without reading configuration, discovering keys, touching Prisma
or starting network work. A future explicit composition must supply genuine
Core native authority, retained-access owner and the purpose-qualified v2
credential client. Proxy-based generated Prisma services require an explicit
plain server facade whose `withTenant` method delegates to that actual service;
the reader intentionally refuses Proxy/accessor method discovery. This facade
supplies transaction scope only and supplies no authorization. Four base native
verification/currentness methods retain
their owner; only acceptance observation uses Meri v2. Internal HTTP aborts
bound that read and do not cancel an earlier browser-approved continuation.
The frozen v2 reader still supports initial Strategy generation only.

## One Fable receiving requirement

Return one independently reviewed coherent primary Meri commit/tree receiving
the [PR123 frozen Objective v2 Ed25519 contract](https://github.com/neo-capiro/meri-greenfield/blob/b2f0a5d71e1c1b6a6cf79b1e9a496ad663ef641a/docs/objective-source-reader-v2-20261017/CONTRACT.md),
[PR127 pure factories](https://github.com/neo-capiro/meri-greenfield/tree/d1512708859f97b6aa7369dfcc8dd9f6448de911/apps/runtime/objective-source)
and [sealed PR129 source boundary](https://github.com/neo-capiro/meri-greenfield/blob/047526c7022d04af6fd0f8faaae011171ef1eca2/docs/objective-source-reader-v2-20261017/FABLE-BOUNDARY-SUPPLEMENT.md),
with the following actual production-factory composition evidence:

- The protected `{objectiveGeneration, objectiveStrategy}` pair enters the
  genuine immutable `bindFacts` CAS and survives prepare, resolve, registry
  reconstruction, router/poststart verification and expired cleanup with its
  original whole-facts hash and execution expiry.
- Trusted job-to-original-seven-field-binding custody derives only from the
  canonical accepted request/run and actual ISSUED metadata. Finish the reserved
  PostgreSQL adapter's uncertainty/final-cleanup defects, missing adapter tests,
  durable issuance reverse lookup and storage/retention/permission qualification.
- Genuine prepared facts reach completion capture. Fresh native authority,
  durable replay custody and the strict retained owner compose behind the three
  fixed v2 accepted-source, historical-source and retained-result paths, with
  separate purpose-qualified issuer/key pins and currentness checks before and
  after reads and replays.
- Evidence covers restart, uncertain commits, stale replay, revocation, purpose
  separation and original execution expiry versus fresh read expiry. Core
  echoes, caller bindings, Temporal credentials and historical RS256 supply no
  replacement authority.

This is a source receiving requirement, not a request for credentials or live
activation. Fable owns Meri fixes and its eventual qualification. Core still
owns genuine native authority/credential bindings and bootstrap capture of the
original raw body for `/internal/objective-workload-authority/decisions`; that
controller currently fails closed without the original bytes. Bootstrap,
Clerk/session code, delegation disabled constraints, shipping pins and live
configuration are unchanged. Frontend serving and authenticated browser
qualification remain separate gates.

## Qualification scope

Focused commands use Node24 and the existing locked dependencies:

```powershell
node apps/api/node_modules/jest/bin/jest.js --config docs/objective-strategy-core-20261017/qualification/core-integration.jest.cjs --runInBand
node apps/api/node_modules/typescript/bin/tsc -p docs/objective-strategy-core-20261017/qualification/core-integration.tsconfig.json --noEmit
```

Node24.19.0: **131/131 tests across seven suites passed**, and strict TypeScript
including the changed PlannerModule source graph exited0 with no diagnostics.
The first expanded module check found omitted same-commit sparse source inputs;
restoring those inputs resolved the check without source or dependency edits.
The tests cover 51 recovery/selection regressions, 27 native-reader cases,
25 runtime-composition cases and 28 existing receiving cases. The PlannerModule
test inspects its real provider metadata with unrelated providers stubbed; it
does not bootstrap AppModule, HTTP listeners or schedulers.

Independent source review accepted recovery, native custody reconstruction,
runtime ownership and socket cancellation. Ten additional independent native
and transport probes passed over synthetic rows/authority and unconnected
native sockets. A separate read-only gap audit found no additional confirmed
Core-only defect in the bounded route/replay/receiving slice.

Fixtures explicitly label synthetic native authorization, rows,
transactions, keys and transport. The actual Core ledger/publication readers,
v2 client/JWT, acceptance validators, receiving and result-owner factories run
unchanged. This is source qualification, not live native authority or Meri
custody qualification. PR61's PostgreSQL39/39 belongs only to its original
`eef7cd1b874549bc2115b313ebb00fe83e2e57da` source/run and is not repeated or
transferred to this successor. No native SQL was executed. No migration,
credentials, AWS, image build, deployment or activation is part of this change.
