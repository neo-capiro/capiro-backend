# Versioned preserving Strategy regeneration

Isolated source successor of local `8009706cf7b73747314f10582690a0b48b1c0469`.
The sealed checkpoint is unchanged. This work is source-only and unpublished;
the existing publication hold, disabled workload verifier and native ACL STOP
remain in force. It adds no SQL, schema, journal, provider call or deployment.

## Private versioned request

The existing fixed generation-request POST201 and GET200 retain their five-field
publication wrapper and current `publish` / `request-read` authority phases.
Initial requests still use exact Meri candidate4d8, with `basis:null`. A genuine
nonnull expected Strategy version selects a distinct private Core request:

```
requestVersion: capiro.objective-strategy.regeneration-request/20261016.1
operation: strategy.draft
applicationTarget: {mode: regenerate, canonical: <full original token>,
                    expectedStrategyVersionId: <actual sealed head>}
basis: <complete owner-captured packet>
basisSha256: <Core hash of the entire packet>
```

This does not masquerade as candidate4d8, add a fourth Strategy operation, change
the workload action `objective.strategy.draft`, or switch to an assistant edit.
Actual Meri validation, protected-facts publication and typed-result custody
must explicitly integrate this private version before it can run. The separately
authored Meri custody source has no acceptance or runtime qualification inferred
here. The publisher carries the actual compiled prompt and owner observations,
preserving DTO/source/delegation/original-expiry semantics from checkpoint800.
No source content is exported around the publication hold.

First publication captures the basis under the actual queued job, source,
Strategy, head and consent fences. Context compilation remains outside the
transaction. Final publication recaptures the entire basis and compares its
whole hash before atomically saving the request and job context. A later human
edit, archive, source move or head change refuses rather than recompiling or
adopting another head. Retained lookup reconstructs the historical request and
does not claim it is still eligible to apply.

Initial candidate hashing keeps its existing restricted domain. The private
version uses finite-JSON JCS for full requests/publications, because actual
opaque provenance or target references may contain fractional values. Typed
identity/time fields still have their existing safe-integer checks. The complete
private request/publication/basis/evidence bounds refuse overflow; no partial
history, node list or prompt is substituted.

## Three-way source ownership

The pure merge compares the captured current snapshot, each original machine
baseline, and the new normalized proposal. Canonical Strategy and source-key
node IDs remain stable. New keys use the existing deterministic identity domain;
collisions with live/manual/archived identities refuse.

- Title, note, schedule/kind/subject and dependency fields change only when the
  current value still equals its last applied machine baseline.
- Existing status, owner, provenance, target reference, creation identity and
  execution history remain intact. Proposed differences are recorded explicitly.
- Strategy metadata stays intact except `meriSummary`, which uses the same
  three-way comparison. No source title or goal overwrites a human title/goal.
- Omitted work, manual additions and all archived identities remain. Archived
  proposals refuse; regeneration never deletes, archives or resurrects a node.
- The entire merged live graph is checked, including untouched human/context
  nodes. Missing or cyclic references refuse before writes. A proposed dependency
  that human preservation would omit also refuses instead of silently dropping it.

The existing typed draft proposal bound is not a global task or Strategy limit.
The complete merged graph and cumulative associations are never sliced to it.
Multiple projects, manual groups and shared task memberships are unchanged.

## Actual application transaction

`MeriService.applyCanonicalRegeneration` invokes no model. It reads the genuine
retained publication/job association, checks the normalization against that
original request and captures the immutable input hash. Existing external
source re-observation runs before the write transaction.

Inside the existing transaction it first awaits the Objective completion
`beforeWrite` hook. It re-reads job/publication, recaptures the exact current
basis under Strategy/head/node locks, and compares the complete original basis.
It validates the full merged graph and existing realism verifier before writing.
Only the explicit source patches and genuinely new nodes are persisted; new
creation timestamps use the captured actual database clock.

One noncoalescible exact Strategy version is cut. The cumulative normalization
record and existing activity/outbox are written, then the existing `afterWrite`
hook atomically completes the original fenced job with its exact Strategy/version
receipt and producer association. A failed patch CAS, version, evidence check,
deadline, authority or completion CAS rolls back all changes. There is no
post-hoc receipt or model-spanning transaction.

The collection guarantee relies on the existing application writers taking the
Strategy mutation lock. Row locks alone do not prove phantom exclusion against
an uncoordinated database writer. Native app-role/RLS/grants/lock/concurrency
qualification remains necessary; source fixtures do not establish it.

## Cumulative baseline custody

Normalization schema2 uses the SAME private kind, table and deterministic
job-scoped identity as the initial schema1 record. It retains the full original
basis, exact ordered predecessor identities, normalized proposal, field decisions,
merged output, and original admission/acceptance/producer/saved-version hashes.
There is no second result journal or scheduler.

The basis owner reconstructs one complete chain: one genuine initial record,
then each exact schema2 predecessor prefix. Gaps, branches, cycles, unknown
schemas, wrong historical actor namespaces or conflicting versions refuse.
Each record is replayed against its original captured basis and checked against
actual retained producers and immutable saved versions. A saved human value
cannot silently become a new machine baseline. Archive IDs/times stay explicit;
full current archived payloads are not claimed by the basis packet.

## Planner and qualification boundary

Applying a Strategy does not authorize Planner. This writer makes no Planner
call. The deterministic Planner application remains separately fenced by the
original, currently valid `objective.plan.prepare` consent, work identity and
actual Strategy receipt. A generation consent is never reused as that grant.

Focused checks use actual source helpers/method bodies with declared synthetic
owner/SQL-response ports. They qualify neither SQL locks nor SDK custody, a
genuine verifier, framework wiring or deployment. A coherent exact-source
semantic/native batch must be admitted by Qualification; native execution is
blocked until its existing ACL preconditions are met without bypass. No
compiler, database or provider run is implied by this source allocation.
