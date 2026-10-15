# Objective operational page: authoritative binding proposal v1

Status: docs-only, unregistered proposal for joint Core/frontend allocation. No endpoint,
operation registry, application model, migration, consumer or UI panel is implemented here.
The full target is Figma node `411:61442`, not only the intake editor. Backend base is
`9eb3dd0253bb9080097432f462fa529eac5f60a7`; frontend reference is PR53
`e9df91d876eaad05d13fdd0707c1fe39d5affb62`. `SOURCE-MAP.json` records the actual owners;
`SOURCE-PINS.json` binds the inspected bytes. Meri and the paused publisher are excluded.

Receiving successor: preserves published checkpoint `470274e1` and corrects frontend
findings O1–O4. `IMPLEMENTATION-PLAN.md` gives the proposed source allocation and remaining
product questions. This remains an unregistered draft, not a wire freeze or application.

## Finding and proposed boundary

Existing owners can supply Objective revisions, saved Strategies, Planner projects/tasks,
typed Planner approval tasks, session-specific Outreach proposals, budget context and
client-level engagement context. Most have no durable Objective membership. The five
existing Objective destination operations check a selected same-client resource against
the current Objective revision; their receipts explicitly describe observations, not
stored associations. A client search, matching title/year, reserved UUID, session text,
or generated task count cannot repair that missing relationship.

Propose a Core-owned, versioned operational read over **verified associations**, with
owner-resolved resources and delegated actions. Preserve the existing intake API and
`draft | in_review | ready` lifecycle. One canonical generated association coexists with
manual Strategies, any number of projects/groups and shared tasks. A read never creates,
adopts, rebinds, activates or dispatches anything. Browser rendering does not continue
generation. The inert confirm-ready intent remains the continuation source; its consumer
and applied publication are separate, currently unimplemented dependencies.

## Authoritative membership and provenance

Two sources of membership are accepted, and are distinguishable on every row:

1. A verified durable application/materialization receipt, resolved server-side by its
   owning service and exact Objective/revision/source/output chain. Canonical reserved IDs
   alone do not qualify. Existing actor/request-scoped receipts cannot become a tenant-wide
   discovery feed; cross-actor discovery requires a separately authorized Core applied link.
2. An explicit Core operational association created by an authorized human command. Its
   immutable identity contains tenant/client/Objective, kind/resource ID, linking Objective
   revision, actor, time, request identity and tombstone history. It grants no resource
   permission. The stable association survives later Objective edits as historical
   attribution; `linkedRevision` is never relabelled the latest revision. Unlinking changes
   membership, not the source resource. It does not delete shared tasks or undo work.
   Manual provenance exposes its authorized `via` selection; one association ID cannot
   refer to unrelated resources. A task may inherit the same project association only
   after its current membership is verified by Planner; that is not a new task link.

The proposed association set has a version independent of Objective content version and
canonical generated binding version. Link/unlink uses an expected set version and exact
current Objective version in one Core transaction. Version 0 means a verified empty
implemented set; null means no implemented/available association-set reader, not empty.
No SQL/table name or migration number is allocated by this proposal.

Resource kinds in the initial association command are saved `strategy`, `planner_project`,
`planner_task`, `outreach_session` and `meeting`. Budget package/cycle references are
optional cycle context, not independent Objective work items.
Question membership is held until an authoritative question owner is identified; the read
has a truthful questions section meanwhile. Do not create a second question entity from a
label or a Strategy risk/decision node. A project association includes its current readable
task memberships; an explicit task association includes that task. Union/deduplicate by
task ID, including shared memberships. A session association attributes that session's
current review proposals, not every session owned by the actor.

Cycle presentation is explicit context on a Strategy association, not a new Strategy status.
A human may associate a fiscal-year annotation, optionally an exact authorized BudgetPackage
or DefenseBudgetCycle identity. Store its provenance as `human_annotation`; returned budget
facts remain separately attributed to their owner. A Strategy can have multiple cycle
annotations. Never infer a year from its title, type or target date. Global budget cycles
have no Objective/client relation; their internal-only guard stays intact. No global cycle
data is exposed by this page merely because the user can read the Objective.

## Proposed public contracts

`CONTRACT.schema.json` defines closed request, response and error variants. These names and
paths are allocation candidates, not callable APIs or frozen exports:

| Candidate | Shape and use |
| --- | --- |
| GET `clients/:clientId/objectives/operational?objectiveId=...` | `ReadRequest`; returns `ReadResponse` for the entire page with independently paginated sections. Optional `cursors` is represented in the schema as a client request object; a registry adapter must encode its named fields, not send JSON in an unspecified URL body. `limit` is a page size of 1–100, not a product/task cap. |
| POST `clients/:clientId/objectives/operational-associations` | `AssociationCommand`; only human link/unlink, with durable request ID and current Objective/set CAS. Returns `AssociationReceipt`. No underlying Strategy, Planner, meeting, send, or budget action occurs. |
| GET `clients/:clientId/objectives/operational-associations/:requestId` | `AssociationLookupRequest`; exact request receipt recovery after an uncertain POST. Actor/tenant/Objective-scoped. A missing receipt does not prove a prior POST wrote nothing. |

Candidate registry names are `objectives.operational.read`, `objectives.operational.link`
and `objectives.operational.receipt`. Existing CRUD continues through its current Portfolio
API bindings. No shared package or registry change is included.

The read covers all page sections: Strategies across cycles; Planner projects and progress;
decisions waiting; open intelligence questions; next engagement. Each section carries its
own `observedAt`, coverage, safe reasons, cursor and nullable total. A complete empty list
with total 0 is distinct from `unbound`, `not_implemented`, `unavailable` or `partial`.
Unavailable/partial data has null totals. `complete` means all currently readable, verified
memberships were considered, not all tenant/client records or a cross-service snapshot.
Following a cursor must retain the same actor, Objective identity, current revision,
association-set version and owner observation token; drift returns 409 and restarts that
section. No item is silently dropped to satisfy page or transport limits.

`automation` reuses the accepted composite schema byte-for-byte when available. Its current,
requested, Strategy-applied and Planner-applied revisions/intents remain separate. Pending
does not imply running; custody does not imply application. Older applied outputs remain
visible under fresh authority while a newer request is pending/stale/failed. Today the
composite read/applied publisher is unimplemented: return `not_implemented`, projection null.
Do not synthesize a composite from reservation IDs or this operational association set.
Accepted composite semantic/witness checks are an additional gate to JSON-schema validation.

## Section and action semantics

| Page surface | Authoritative meaning / action |
| --- | --- |
| Strategies across cycles | One readable Strategy row per verified Strategy membership; deduplicate by Strategy ID and combine explicit cycle annotations. Source title/type/current observation come from Strategy. Pins identify original saved versions; existing generated receiving renders current authorized content after exact job/source checks. Frozen snapshot receiving is a separate allocation, never implied by a pinned ID. No guessed `active`, `achievable`, `compressed` or `next_cycle` state. |
| Planner projects and counters | Resolve every verified project and task under current Planner ACLs. Count unique nonarchived task IDs; completed means canonical `status=done`. Overdue uses the owner's canonical deadline/overdue helper from `dueOn`, `dueTime` and `timeZone` at the stated `asOf`; there is no invented public dueAt field or 30-day horizon. Projects and personal/manual/shared tasks retain their IDs and human edits. Creation counts and original memberships remain lineage, not current progress. No `waiting_for_window` counter without an existing authoritative scheduling rule. |
| Decisions waiting | Initially only pending tasks whose canonical subtype is `approval`, and pending command proposals in explicitly linked Outreach sessions. A normal task's default `approval=pending` is not a decision. Review opens the existing owner; approval/rejection uses that owner's current version/permission/flags and command, never a generic Objective approve endpoint. Budget watch acknowledgements and extraction-review decisions are different domains and are not pooled. Compatibility Outreach events cannot double-count one decision. |
| Open intelligence questions | Expose `not_implemented`/`unbound` with null count until an actual question entity, open predicate and Objective membership owner are proven. Do not relabel intelligence insights, alerts or Strategy context nodes as questions. This is an explicit full-page gap, not a zero KPI. |
| Next engagement | Only explicitly associated, readable meetings with a real scheduled start can qualify. Resolve current cancellation/deletion/visibility/time permissions through the meeting owner, then earliest start >= asOf. A linked Outreach session is not a scheduled meeting. Existing portfolio `nextTouch` is client context, not an Objective next event. Session free text or a debrief does not manufacture a date. |

Read action descriptors are closed navigation/review intents with exact resource IDs and
observed versions, plus existing `edit_objective`/`request_review`/`confirm_ready` selectors.
They are not capabilities or executable URLs. Permission is checked again when opening or
writing. Existing bound receiving views stay read-only; show a writable action only where
the owning ordinary surface supports it. Core owner UUIDs must not be substituted for Planner
Clerk subjects. No batch approval, invitation, recurrence, assignment, rule, send, background
external workflow, or activation is created by a projection or link.

## Privacy, consistency and errors

Core first authenticates active membership/role, current nonarchived client/wall grant and
undeleted Objective. Each source owner then resolves exact IDs using its current authority.
The older Strategy tenant-only list/detail implementation is not sufficient proof of current
client permission; its independent permission repair must be reconciled before exposure.
The read cannot widen permissions by joining directly to another owner's tables.

Hidden resource IDs, titles, cycle facts, Strategy lineage, node IDs, counts and review
selectors are absent. If the caller is permitted to know the Objective association exists,
only a generic partial-coverage notice may remain. Otherwise withhold its content using
the indistinguishable unavailable shape defined below.
An authorized project may remain visible even when its Strategy lineage is hidden; omit the
lineage independently as in the accepted composite contract. Do not reveal denied-resource
counts. A receipt or cursor is never a permission grant.

Observations are as-of their named owner read. No model/network call runs in a Core write
transaction. No global table lock or cross-service atomic snapshot is proposed. Revoke,
move, archive, edit, or membership changes between read and action are rechecked by the
owning command. The projection digest is equality/change detection only; it cannot order
progress. Discard responses from superseded local requests, including late older cursors.

Errors use the strict safe allowlist: 400 malformed request, 401 unauthenticated, 403
insufficient application role, 404 scoped
Objective/resource/receipt not available, 409 current Objective/set/cursor/idempotency
conflict, 422 unsupported resource selection, 503 owner/receipt temporarily unverifiable.
Messages are fixed safe codes; no SQL, provider error, hidden ID, stack or token. 404 on
receipt recovery and 503 after a command both have `outcome=unknown`; neither asserts no
writes. An admitted repeated request with the same payload returns the same immutable
association receipt after current authorization; changed payload conflicts. Receipt lookup
returns historical linked revision/result set version, never silently relabelled current.
Current readable resources come from a fresh operational read. An unlink receipt never
claims the underlying resource was deleted.

## Allocation and acceptance sequence

1. Jointly review this read/action shape and exact source mapping; frontend can prepare
   receiving tests without inventing server states or new approval workflows.
2. Allocate Core association persistence, idempotency and exact request lookup, migration
   writer, current-authority adapters and permissions reconciliation. Ordinary resource
   writers stay with their owners. No migration is reserved or executed here.
3. Implement/read-test membership, pagination, counts, redaction, historical lineage,
   current ACLs and stale-action refusal. The first receiving increment may render partial
   sections honestly; full-page acceptance still requires every agreed section.
4. Separately reconcile the existing composite reader and applied-link publisher with its
   current owners. This proposal does not unblock that paused work or allocate Meri work.

Required adversaries include same-client-but-unlinked exclusion; denied/archived/moved
resources; hidden lineage with visible project; shared task deduplication; normal tasks
with default pending approval; paged count completeness; owner failure; stale cursor/CAS;
lost reply/same request; current versus requested/applied split; no question/date/window
fabrication; and resource edits/revocation after a read. Offline fixtures in this checkpoint
validate proposal conformance only. No application, PostgreSQL/RLS, bridge or live proof is
claimed.

## Normative conformance details

These requirements accompany the closed schema; shape validation alone is insufficient.

- Successful proposed GET/POST/receipt-lookup responses are HTTP 200 with
  `Cache-Control: private, no-store`. Decoded path clientId must equal the schema's clientId;
  the receipt path requestId must equal the decoded request identity. GET query fields are
  `schemaVersion=1`, `objectiveId`, `limit` and optional `strategiesCursor`, `projectsCursor`,
  `decisionsCursor`, `engagementsCursor`, mapped to the schema's named cursors; absent means
  null. Receipt lookup additionally requires objectiveId. Reject duplicate/unknown query
  fields and path/body mismatches. There is no JSON GET body or dynamic arbitrary URL.
- Outer `projectionDigest` is SHA-256 over canonical JSON of the full public read response
  excluding that digest field. It detects equality, not authority or progress order. The
  inherited composite's own digest/receipt rules remain unchanged. A freshly authorized
  read is required even when a cached digest matches.

- All five sections remain present. When even association existence is not disclosable,
  use the same neutral `unavailable` shape as an unverifiable owner: empty items, null
  snapshot/cursor/total and `source_unverifiable`. Do not encode a denied ID or denial
  count. `authorization_limited` is permitted only when that general coverage fact is
  itself authorized. Withholding means withholding section content, not changing shape.
- A human link requires current Objective write authority and exact resource-owner read
  authority **and same-client eligibility**, not merely access to two clients. Strategy,
  project and task must have the exact client ID through their canonical owner; an
  unassigned personal resource is not implicitly eligible. Outreach must have exactly one
  matching client sponsor. Meeting relevance must pass the owner's explicit client
  assignment/contact-association rule. No cross-client relink is performed. Optional
  global budget context is the stated exception: exact owner read/internal guard plus a
  deliberate annotation, never a client relationship inferred from fiscal year.
- Active manual membership is unique by tenant/client/Objective/resource kind/resource ID.
  Same selection and identical canonical cycle annotations returns `unchanged`; changed
  annotations conflict, requiring explicit unlink then link with new request identities.
  Unlink of that known already-unlinked association is `unchanged`. Unknown/foreign IDs
  return 404, not a fabricated receipt. No-op commands persist their own receipt but do
  not advance set version. Actual link/unlink advances it exactly once.
- `commandRevision` is the Objective revision admitted for this command.
  `associationLinkedRevision` is the original linking revision, including on unlink and
  no-op. New `linked` requires them equal; unchanged historical links may differ. A
  receipt binds the exact canonical request's `payloadDigest`, scope, action, association,
  outcome and resulting set version. Canonical JSON means recursively sorted object
  keys, original string content, arrays in order, compact UTF-8; no floats in requests.
  Request hashing retains the original array order. For membership equality, compare
  unique cycle annotations as a set of their canonical JSON strings; reordered annotations
  can be a new request's no-op, but changed payload under the same request ID conflicts.
- Request receipt lookup/replay reauthorizes the current caller/scope first. If an exact
  receipt exists, return that immutable historical outcome before applying present CAS;
  do not reapply the command after later edits/unlinks. A new request must pass both CAS
  values. `rejected` describes this submitted payload's admission; it does not deny a
  different payload or older same-identity outcome. A missing/uncertain receipt stays
  unknown. No actor's request ID grants cross-actor discovery.
- Complete sections require a nonnull owner observation token, exact total and no reason
  codes. Partial sections may contain authorized rows but have null total; unbound,
  unavailable and not-implemented sections contain no rows/cursors/totals. No implemented
  association reader means no complete membership section or exact Planner metric.
  `unbound` is distinct from an implemented verified empty membership set, which is
  complete with total 0. Question rows remain unsupported in this candidate.
- Cursors are opaque and integrity protected, bound to tenant, actor, client, Objective,
  section, current Objective revision, association-set version, owner observation token,
  stable asOf, sort/filter and page-size policy. Cross-section swap, tamper, source drift
  or authority change fails safely and restarts the section; cursors grant no authority.
  Order Strategies/projects by stable source title then ID, decisions by owner creation
  time then kind/ID, meetings by startsAt then ID. Return the chosen source ordering key
  through the opaque cursor, not a client-supplied comparator. Next engagement is shown
  only after complete coverage proves the global minimum; a partial first page cannot.
- Top-level `asOf` is the fixed server selection cutoff for overdue and future meetings;
  `observedAt` is completion of projection observation. Planner metrics use that same
  asOf. Per-owner observation times remain explicit and do not imply one atomic snapshot.
  Every nonnull cursor in one request must carry the same initial asOf; mixed cutoffs
  conflict. Later pages preserve it rather than silently switching calendar windows.
- Planner metrics need a complete current readable associated task union independent of
  project list pagination. Noncomplete metrics have all three counters null. Done and
  overdue are disjoint subsets, so their sum cannot exceed taskCount. No schedule-window
  or created-now counter is inferred. Meeting dates remain actual owner fields.
- Deduplicate Strategy/project/meeting rows by resource ID; decisions by kind plus exact
  task or session/proposal ID. A Strategy row can retain multiple authorized `savedVersions`,
  each bound to its own application receipt and original source revision. A manual link
  cannot manufacture a saved-version pin. Do not choose an arbitrary receipt as current.
  Every immutable version ID agrees on its owning Strategy and digest across receipts.
  Ordinary `open_resource` has `contentView=current` and no saved-version selector.
  `open_generated_strategy` requires an owner-resolved nonnull generatedJobId, exact
  Strategy/version/digest/sourceRevision and `contentView=current`. It is emitted only
  when that source revision equals the current Objective; the existing receiver refuses
  stale bindings. A generic receipt ID is never used as a generation job ID.
- Every open/review action must match a visible authorized row and exact observed version;
  pending approval-task review and session/proposal review are different selectors.
  Outreach's existing reject path checks owned/pending state; apply additionally checks
  nonarchived session and exact state version. A pending count alone proves neither
  current applicability nor authority to apply. Review opens that owner without claiming
  every pending historical proposal can still be applied.
  Objective action versions equal `scope.objectiveVersion`. No descriptor contains a
  bearer, free URL or executable command. The unchanged accepted composite must also pass
  its full source/receipt/epoch/stage semantic witness rules before being exposed.
- Resource titles preserve the owner's actual nullable/empty value. In particular an
  untitled Outreach session is still eligible for a review row. A renderer may label an
  absent title as a display fallback, but it cannot replace source data or omit work.

The only genuinely undefined business semantics found here are question-level ownership /
resolution and the screenshot's feasibility/window labels. Those remain explicit gaps for
their domain owners. The association, pagination, counters and delegation mapping above are
concrete engineering proposals; they need allocation and ordinary review, not a new
Objective lifecycle or generic approval policy.

## Receiving corrections and receipt resolution (O1–O4)

Manual `associationId` maps to one immutable `via` resource, linked revision and creation
time everywhere it appears. Project-derived task provenance keeps that project selection;
the Planner reader proves the membership before returning it and does not expose a hidden
project through provenance. The positive examples use distinct Strategy/project/task/meeting
memberships. Immutable version IDs map to one Strategy/digest even when several verified
receipt witnesses refer to them. Missing job mapping is explicitly null on the pin.

Page conformance receives the decoded read request and accumulated section context in
addition to the response. An initial complete page with no nextCursor must account for its
entire total. A continuation checks prior distinct identities, scope, association version,
asOf, snapshot and cursor; a final page's own length may be smaller than its global total.
Repeated identities, mixed snapshots, early termination and no-progress cursors fail.
The offline helper demonstrates these relations, not cursor signatures or real DB paging.

The Strategy application read facade owns `resolveObjectiveReceipt`, a proposed read-only
internal method, not a new Meri protocol. Its input is a server-owned typed receipt locator,
never an arbitrary UUID guessed from the browser:

| Existing source | Authoritative resolution |
| --- | --- |
| Caller-known generation job | Resolve actual tenant/actor-scoped `sp_draft_job.id`; validate the completed embedded Objective receipt, request identity, client/Objective/revision, Strategy ID and exact immutable `sp_version` snapshot/digest. Existing Planner `materializationSource` demonstrates these application checks. This is read reuse, not producer/worker modification. |
| Caller-known materialization request | Existing `PlannerService.strategyMaterialization(ctx, requestId)` validates the deterministic private receipt, immutable creation/source chain and current output availability. Its `source.generationJobId` supplies the actual job locator; receipt ID and request ID are not interchangeable with job ID. |
| Future Core applied publication | Must persist an exact server-owned locator/mapping to its existing application receipt. That producer remains a separate unimplemented gate. No scan/adoption of the latest job or reserved ID substitutes for it. |

The facade emits `generatedJobId` only after the actual job lookup and exact version proof.
Current `ObjectiveGeneratedStrategy` still fetches `strategies.objectiveDraftJob`, checks
`requireGeneratedStrategy`, fetches `strategies.objectiveDestination` and matches the returned
Objective revision. `open_generated_strategy` maps those exact selectors, not a fabricated
full job response; the receiving component reauthorizes on open. It explicitly displays
**current authorized Strategy content**, with the saved version named as provenance.

Frozen saved content needs a separately allocated, read-only Strategy version reader and
frontend receiver. `VersionService.list` returns history metadata; `loadStrategyDetail`
returns the live plan. Neither is a frozen-content endpoint. The prospective allocation is
listed in `IMPLEMENTATION-PLAN.md`. Until its contract is reviewed, no frozen-content action
is emitted and no `contentView=saved_snapshot` is accepted by this schema. Old-revision pins
remain provenance under current permissions; they do not weaken the current receiver's
stale-revision check or rewrite current/applied pointers. A normal current-resource action
can remain available independently when the source owner authorizes it.
