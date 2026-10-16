# Objective Planner receiving trust allocation

Status: private server source, including initial canonical Strategy application and Planner v3 reconciliation, authored in the separate `objective-canonical-producer` checkout. This document does not approve a public wire protocol, authenticate a workload, apply a migration, or qualify a runtime. Original application base is `5afc530a6907c74b21db3ea59103def6cb5a20a5` (parent `622905839c7a510ab01a512ef8012926b2e1b4ce`); sealed checkpoints and their evidence remain historical exact-pin records. Current producer behavior and remaining upstream gates are summarized in [the producer README](../objective-canonical-producer-20261016/README.md).

The receiving owner is **API-Strategy**, in the Planner owner's existing Prisma transaction. Core Objective reservation, authority, consent and control facts are read through their current owners. Meri owns workload authentication/delegation and generation. No generation-job UUID is inferred to be a Meri run UUID.

## Fixed operation and closed request

The controller-relative routes are `POST /internal/objective-canonical/planner-applications` and `GET /internal/objective-canonical/planner-applications/:applicationRequestId`. The actual service sets the global prefix `/strategy-api` in `apps/api-strategy/src/main.ts`, so the fixed deployed paths are **`POST /strategy-api/internal/objective-canonical/planner-applications`** and **`GET /strategy-api/internal/objective-canonical/planner-applications/:applicationRequestId`**. No proxy rewrite has been established or is assumed. Trusted transport uses its approved bare service origin plus these literal deployed paths; a caller cannot select a path/origin. This metadata clarification changes no request/ACK fields or live routing. The operation is fixed by the route to `objective.plan.prepare` and is absent from the body. The POST has exactly these nine fields:

```ts
{
  schemaVersion: 1;
  canonical: {
    canonicalPlanId: UUID; tenantId: UUID; clientId: UUID; objectiveId: UUID;
    canonicalStrategyId: UUID; canonicalProjectId: UUID;
    bindingVersion: PositiveInt32; epoch: 1;
    requestedIntentId: UUID; requestedObjectiveRevisionId: UUID;
    requestedObjectiveVersion: PositiveInt32; snapshotHash: LowercaseSha256;
  };
  applicationRequestId: UUID;
  generationJobId: UUID;
  generationRequestId: UUID;
  strategyId: UUID;
  strategyVersionId: UUID;
  objectiveReceiptSha256: LowercaseSha256;
  snapshotDigest: LowercaseSha256;
}
```

UUID strings use the source parser's lowercase version 1–8/standard-variant syntax. Unknown fields, accessor properties, proxies and non-data objects fail closed. `strategyId` must equal `canonical.canonicalStrategyId`. No actor, role, groups, model output, result reference or credential is accepted in the body. The generation IDs identify the actual existing Strategy generation job/request, correlated against the owner receipt and saved version.

`applicationRequestId` is the kernel's deterministic private UUID derived from namespace `capiro.objective-plan.application:v1`, the full original twelve-field canonical token and the delegated Core actor UUID. Changing job/version/digest under that identity conflicts; a consent retry alone does not allocate a second effect. The request digest uses UTF-8 finite JSON with sorted object keys, original array order and no whitespace, matching the Objective convention; it is not a claim of RFC 8785/JCS conformance.

## Exact missing trust port

`ObjectiveCanonicalWorkloadAuthority.verify(request, subject)` is the admission port. The subject contains purpose (`effect` or `retained-result-read`), application request ID and request SHA (null on the initial GET selector). The port must authenticate a **named Meri workload and Core/API-Strategy audience**, its authority to perform this fixed operation, the exact original delegated native actor and tenant/client scope, and the immutable original request. It must resolve the GET selector to that same retained original identity rather than accepting a caller-provided actor. Selection and digests confer no authority.

The service-facing grant is closed by its implementation contract to `tenantId`, `actorUserId` (Core UUID), `clerkUserId` (unmodified Clerk subject), `consentId`, `controlVersion`, `tokenExpiresAtMs`, `delegationExpiresAtMs`, `claimExpiresAtMs`, `requestSha256` and `canonicalSha256`. The verifier must correlate these values to authenticated issuer/audience, scope and claim evidence; those facts need not become new caller-writable body fields.

`assertCurrent(tx, grant, subject)` must enforce the approved transaction-local claim/revocation fence for that exact subject. Effect admission requires current effect/delegation/claim authority; retained-result read has its own current read authority and must not revive expired or cancelled effect consent. No network, model, provider or remote identity call belongs inside the database transaction. The concrete issuer verification and current-claim witness remain unbound: both methods currently throw `AUTHORITY_UNAVAILABLE`. Enabling them requires the Meri owner's exact implementation and review, not a permissive default or a fabricated credential.

Existing `TenantContextMiddleware.readApplicationAuthority` proves a live Clerk request through a request-local WeakMap, online session and current native membership checks. Its returned hash/receipt cannot authenticate a later workload request. `InternalServiceGuard` proves only possession of a generic internal secret; it does not assign this workload, delegated actor, write scope or claim. Neither is substituted for this port, and no bearer is minted, impersonated or forwarded by this allocation.

Current product consent allocation is `capiro.objective-generation-consent`, revision 1, configured maximum 30 minutes, with stricter effective limits preserved. The Core reconsent/control migration is centrally allocated `20281015050000`. Prior source-scoped findings about a missing duration binding at Core `5afc530` and Meri-owner `b8b75414340fc6e0367f50dbefdb01c3830f823b` describe those earlier pins; they are not a claim about all branches or a substitute for the newly allocated policy. Temporal/task-token lifetimes do not independently set human consent duration.

## Owner application, canonical mapping and ledgers

The existing private `sp_planner_resources` ledger stores three distinct kinds:

| Kind | Meaning |
| --- | --- |
| `objective_canonical_materialization_receipt` | Planner-owner evidence: exact historical initial-creation version 2, or reconciliation version 3 with the same source fields plus checked predecessor, cumulative node/task index, machine baselines and field/edge/count/version witnesses. |
| `objective_canonical_application_receipt` | Receiving result, receipt version 1; exact original request, rebuilt immutable creation ACK and ACK SHA. Inserted once for the actor/application identity. |
| `objective_canonical_application_head` | Explicit latest applied pointer for the canonical plan; stores canonical token, application request ID, ACK SHA, source, actual Strategy ID and reserved project ID. Advanced by compare-and-swap, independently of Core `requested_*` state. |

These kinds, and the separate `objective_canonical_generation_admission`, `objective_canonical_generation_acceptance` and `objective_canonical_generation_producer` kinds, are private and excluded from generic Planner resource access. Insert-only receipt behavior is an application invariant under the owner transaction and lock; it is not a claim that the generic SP table has a new database immutability trigger. No new application-receipt table, model or `60000` migration is allocated here. Native grants/RLS/concurrency remain unqualified until separately tested.

The automatic canonical materializer accepts no groups. One identity resolver supplies the actual `canonical.canonicalProjectId` for the one `default` project to **row insertion, initial task membership and both creation projections**. It cannot rename/alias an arbitrary first manual group. Initial/new tasks use deterministic actor/application/source-node IDs; retained or readded nodes reuse the cumulative prior source-node/task mapping. Existing human membership edits and multihoming are preserved. Public manual multi-group materialization keeps its existing behavior and separate receipt kind.

The passed-transaction owner now reconciles an existing canonical project only when the receiving owner supplies a checked prior head/application ACK/owner receipt pair. An unrelated collision still refuses. For an advancing Objective revision and binding version, v3 locks the actual project and mapped tasks, checks current editor/client/archived state, applies three-way source-owned fields against the last machine baseline, and preserves human status/approval/assignee/recurrence/time/memberships/custom fields. Removed tasks and their original IDs remain in history; there is no deletion, archive, clone or automatic restoration. All proposed task dependencies must survive the merge, and the complete merged human/task graph must be valid before writes. A missing/cyclic graph or a preserved human dependency field leaving a proposed task edge unapplied is a 422 refusal with zero writes. Same-revision deliberate regeneration remains a separate identity/head-policy gap.

The actual initial Strategy writer is now `MeriService.applyCanonicalDraft`, reusing the existing Strategy/nodes/exact-version transaction and Objective completion hooks with the reserved Strategy ID and normalized stable node IDs. It calls no model. It deliberately refuses an existing `expectedStrategyVersionId`: the reviewed typed draft request still requires `basis:null`, and there is no enabled genuine retained-basis/result-custody adapter. Downstream Planner v3 source does not close that upstream Strategy regeneration gap.

## Immutable ACK and current observation

The creation ACK has exactly: `schemaVersion`, fixed `operation`, `applicationRequestId`, `requestSha256`, full `canonical`, `actorUserId`, `consentId`, `controlVersion`, `source`, `objectiveReceiptSha256`, `ownerReceiptId`, `ownerReceiptSha256`, `recordedAt`, `outcome`, `projects` and `tasks`. `source` contains generation job/request, client, Objective ID/version/revision, actual Strategy ID/version and snapshot digest. Each project contains group key, actual project ID, original creation version and original source-node IDs; each task contains source-node ID, actual task ID, original creation version and original group keys. Original row-creation versions remain 1. Initial owner v2 also has current versions 1; v3 retains original creation versions while private before/applied witnesses and actual current row versions may exceed 1. All outputs in the committed application projection must be available. The ACK stays schemaVersion 1 for either owner receipt version. Outcome is `applied` or `applied_with_issues`.

ACK verification rebuilds the application projection from the validated owner v2/v3 receipt, checks all correlations and compares the full digest. The owner receipt identity and stored content digest bind the particular application evidence. The response places this retained ACK in `creation`, separately from permission-filtered `current: CanonicalMaterializationResult`. Initial v2 counts one created project and all initial tasks; v3 counts zero created projects and only new task rows. These retained application counts do not become current readable totals. Human edits affect current versions/membership/availability, never rewrite the ACK or recreate outputs. If any current output is withheld, the complete creation ACK and SHA are withheld to avoid exposing hidden creation IDs.

Only this private canonical result additionally admits `HUMAN_EDITS_PRESERVED` / `Existing human edits were preserved during plan reconciliation.` and `PRIOR_WORK_RETAINED` / `Work from a prior saved version was retained.` Public/manual issue dictionaries and decoders remain unchanged. The v3 checker reconstructs source IDs, cumulative mapping/baselines, versions, groups, edges, counts and issues against its checked predecessor. It does not recreate raw observed human values, membership state or the full tenant graph from hashes: those are witnesses established by the actual locked transaction reads, merge validation and returned-row checks. No full human/tenant graph is duplicated in the receipt.

Retained GET rechecks current workload read authority, current native actor/membership, client wall/access and Objective/Strategy scope, but does not require the old Objective version, current requested token, old effect consent or worker deadline still to be current. Thus a committed result remains recoverable after Objective advance or effect cancellation, subject to present read access and retained records. It returns the exact original application result, not success inferred from a reservation/head/output row. Missing or malformed paired evidence returns uncertainty, not permission to run another effect. Hard deletion and maintenance retention guarantees are outside this allocation.

The legacy public `GET planner/strategy-materializations/:requestId` is unsuitable as the immutable ACK port: it returns a changing current projection and revalidates the original current source, which can become stale after an Objective edit. The new owner creation lookup is separate and does not rerun generation or the old source-current gate.

## Producer source routes and custody boundary

Registered in `PlannerModule`, the producer controller exports the following fixed paths after the same `/strategy-api` global prefix:

| Method and path below `/strategy-api/internal/objective-canonical` | Success status | Actual source purpose |
| --- | --- | --- |
| `POST /generation-admissions` | 201 | Capture the actual queued, never-claimed Objective job, exact current canonical/source/consent and original clipped expiry. Body contains only `schemaVersion` and `generationJobId`. |
| `GET /generation-admissions/:generationJobId` | 200 | Rebuild retained admission and optional acceptance under current generation read authority; no dispatch. |
| `POST /generation-acceptances` | 201 | Pair that admission with verifier-supplied genuine original Meri request/run/issuance evidence; atomically mark its exact job claimed. Same two-field body, no posted run identity. |
| `POST /generation-producer/admit` | 200 | Read completed producer evidence and evaluate fixed phase `start`, `prepare`, `read` or `stop` against the whole strict phase/work envelope. This is a proof/read boundary, not an apply or remote-cancel endpoint. |

The completion hook records generation producer evidence alongside the exact Strategy version, Objective result receipt and job-completion CAS. Historical producer read reconstructs the same job/version/admission/acceptance rather than following the latest run. The original Strategy-generation consent and later Planner consent are distinct actions and are not equated. `generationStatus: completed` in producer admission reports actual generation evidence; it does not claim Planner application. Its response is not the immutable Planner application ACK. Source hashes, reserved IDs and syntactically accepted run fields cannot establish runtime custody.

All concrete workload/current-claim and genuine generation-acceptance verifier methods still throw `AUTHORITY_UNAVAILABLE`. The source has no enabled transport from an actual immutable typed Meri result into `normalizeCanonicalDraft` and `applyCanonicalDraft`; a caller-selected result cannot fill that gap. The producer route source and initial writer do not establish a working automatic completion loop.

## Transaction and review conditions

New application uses the existing Planner advisory gate, generation-job lock, Strategy lock and exact saved-version lock before current Core authority/Objective, canonical reservation and work-control fences. It validates exact ready intent/revision/hash, token equality, current actor/wall access, selected current consent/control, policy revision and DB-clock expiry. Current tenant Strategy/Planner feature gating must be preserved on both effect and retained-read paths. Do not acquire a canonical row and then reach backward for owner locks.

Owner outputs, owner receipt, application receipt and applied head commit in one existing Prisma transaction. The receiving service repeats current claim/source/consent checks after all writes and before returning; failure rolls back the transaction. No cross-service HTTP request constitutes an atomic owner write. Retained lookup reads the paired historical receipts and projects current outputs under separate read authority; it does not apply the new-write fence.

Before an enabled integration can be accepted, independently verify: closed parsing/stable identity; required Prisma insertion fields and private ledger access; authoritative job/request/receipt/snapshot correlations; real reserved project row/membership IDs; forged ACK rejection; replay before new-write staleness; recovery after Objective advance; current ACL redaction and human edits; expiry/cancel/claim-loss rollback; enabled-feature preservation; and native transaction/grants/RLS behavior. The pure focused test source exercises the actual exported transaction choreography with synthetic ports and an in-memory outer rollback adapter; those cases are unrun at authorship and cannot prove PostgreSQL locks, isolation or rollback. Pure tests and source inspection qualify only their stated scope. Live verifier binding, native execution, provider work, full-loop readiness and runtime admission are not claimed by this document.
