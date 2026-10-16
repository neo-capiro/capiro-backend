# Initial Objective Strategy request publication

Local source successor of `f236b5a065592260bcb52581ee2a719ce96b4429`.
This source adds the real initial typed-request publisher and a read-only
current Strategy basis owner. It does not activate a workload verifier, issue
credentials, run a model, apply migrations or establish automatic completion.
The prior checkpoint and its evidence remain unchanged. Remote publication is
stopped pending Neo's explicit approval of the exact payload and destination.

## Fixed private routes and custody

The registered controller has the effective service prefix `/strategy-api`:

| Method / path | Success | Behavior |
| --- | --- | --- |
| POST `/internal/objective-canonical/generation-requests` | 201 | Publishes one initial typed request from the actual queued, unclaimed attempt-1 job, before Meri acceptance. Body is exactly `{schemaVersion:1,generationJobId}`. |
| GET `/internal/objective-canonical/generation-requests/:generationJobId` | 200 | Reads that same retained publication under fresh read authority. Missing publication is 503 `OUTCOME_UNCONFIRMED`, never absence, eligibility or permission to compile. |

Both return exactly five fields:

```
{schemaVersion:1, sourceAdmissionSha256, request, requestSha256,
 executionContext:{schemaVersion:1,prompt,promptSha256,
                   ownerRefs:[{ownerRef,clerkUserId}],contextPacketId}}
```

`request` is the initial `strategy.draft` Request from the isolated Meri
candidate `4d8bd8ee3d3c6f0c5e1c91edbfebe44598dcf7af`, candidate version
`strategy-candidate/20261015.2`. It preserves the actual queued type, goal,
Meri context, selected owner, target date and attachment IDs according to that
candidate's documented null normalization. Nonempty attachment requests refuse
until an actual currently authorized resolver supplies their observations;
the publisher does not substitute an empty result or fabricate document IDs.
Zero requested attachments produce the candidate's explicit not-requested
legacy observation. No candidate package/export/version changes are made here.

The Core Context Plane adds its private projection only on explicit typed
opt-in. It hashes the full immutable saved Objective revision, independently
of `{source,intent}`, and retains exact source/packet/coverage/prompt pins.
Only explicitly accepted or pending historical Fill artifact metadata becomes
an evidence reference. Accepted recommendations remain historical reviewed
proposals in the full prompt; they are not promoted to current facts. Private
coverage manifests are not added to public receipts.

The full `executionContext.prompt` is the actual bound governed prompt, not a
new prompt assembled from IDs or extracted from chat. The owner map comes
from real active tenant memberships in the final publication transaction.
It is an as-of owner observation; later output persistence must revalidate
assigned owners. Whole request/publication bounds refuse rather than truncate.

## Transaction and replay boundary

The first short transaction locks the actual job and checks retained admission,
current Core authority, current Objective/canonical/consent/control, original
expiry and queued attempt 1. An existing publication returns before any new
compile. Context compilation and source/history re-observation then occur
outside a transaction and invoke no model.

The final short transaction locks the same job, repeats the authority/source
and immutable job-input checks, reads the real active owner map, and uses the
actual database clock. It updates the job's compiled context and appends the
private request ledger row together. A failed CAS, revoked authority, deadline
or retained reconstruction rolls back both. Concurrent callers can compile
independently, but return the one committed publication after the job lock.
These lock and rollback properties require native PostgreSQL qualification;
source fixtures alone do not prove them.

Retained reconstruction checks the real saved Objective revision, actual
job DTO/request/source/marker, compiled admission and full-publication hash.
It recomputes the bound compiled prompt digest and candidate hashes. GET and
POST replay use original timestamps and do not recompile, renew a worker
grant or replace the request. Fresh historical read authority is independent
of permission to start or resume an expired effect.

The existing `sp_planner_resources` table stores the private request kind.
Public resource access explicitly denies it. This is application-level
append-once custody, not a new database immutability guarantee. No schema,
index, migration, lockfile or public browser receipt changes are included.

## Distinct hashes and actual acceptance

- Core `sourceAdmissionSha256` hashes the existing full original admission.
- Candidate `requestSha256` is Meri/JCS over the whole exact typed Request.
- Candidate `inputSha256` excludes only itself from that Request;
  `contextSha256` excludes only itself from its context.
- `promptSha256` hashes raw UTF-8 prompt bytes. The existing compiled
  `inputDigest` instead includes Core's JSON-string prompt digest.
- The stored full-publication SHA binds the five fields, including owner-map
  values and the full execution context. Its JCS may also be computed by the
  actual acceptance observer; it is not a sixth HTTP response field.
- The actual accepted Meri request SHA covers its own complete
  `{requestId,prompt,skill,window,windowRequest}`. Whole prepared-facts SHA
  covers infrastructure facts. Neither is the Core semantic admission SHA.

The acceptance receiver now requires the named trusted observer to compare
the actual protected typed request and execution context with this retained
publication, and to obtain the accepted ID/prompt from the real Meri run store.
Issuance cannot outlive the published original request deadline. No caller POST
metadata substitutes for that observation. `objectiveGeneration` remains its
existing two fields; the actual Meri compiler separately owns protected
`objectiveStrategy` and trusted provider/model selection. All actual verifier
methods remain unavailable by default.

## Existing Strategy basis and remaining gates

`captureCanonicalStrategyBasis` is an actual owner read of the exact sealed
head, complete current live snapshot, archive identities, genuine historical
source-key/node mapping, last machine baselines and paired receipt provenance.
It preserves unassociated human nodes and performs no writes. Unknown future
normalization schemas or multiple initial-only records refuse; a merged human
snapshot cannot silently become a new machine baseline. A 2 MiB whole-packet
bound refuses without selecting or truncating nodes.

The current candidate still requires `basis:null` for draft. A nonnull expected
Strategy version is therefore read and validated, then refused before model
dispatch. No switch to edit, title matching, new IDs, fabricated initial result,
or Strategy regeneration is enabled. A separately allocated versioned typed
request/application-target contract and baseline-preserving Strategy writer
are required to use this basis. The deterministic Planner v3 writer in the
prior checkpoint does not close that upstream dependency.

Required integration gates remain genuine workload/delegation and current
authority bindings, actual accepted request/issuance observation, protected
SDK typed-result custody/readback, real confirmation-owner wiring, semantic
Core/Strategy compilation and native PostgreSQL/RLS/privileges/concurrency.
The native ACL STOP remains in force. No provider, SDK, Temporal, browser,
database or deployment success is claimed by these source fixtures.
