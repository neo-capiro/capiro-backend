# Manual Engagement plans: current receiving wire

**Status: reviewed implementation source candidate; bounded qualification and limits are recorded in [QUALIFICATION.json](QUALIFICATION.json).** This is an exact receiving description of the source snapshot hashed below, not a claim that these routes are deployed or that the shipping backend has changed. The parent accepted the manual lifecycle/review candidate and authorized isolated backend implementation. The immutable accepted direction is [f41be1774131d5a51ed5eaaafdcdade4f50781e3 / PROPOSAL.md](https://github.com/neo-capiro/capiro-backend/blob/f41be1774131d5a51ed5eaaafdcdade4f50781e3/docs/proposed-engagement-contract-20261015/contract-proposal/PROPOSAL.md), SHA-256 `e015eb5672d7e2a1fd1f2004e862defe0f9a58fd1fdf7c30ddc54255b8237658`. Local recovery source: `backend-proposal/docs/proposed-engagement-contract-20261015/contract-proposal/PROPOSAL.md` from the task root. Documentation quality review is not runtime qualification.

Sources: [controller](../../apps/api/src/engagement/plans/engagement-plans.controller.ts), [service](../../apps/api/src/engagement/plans/engagement-plans.service.ts), [store](../../apps/api/src/engagement/plans/engagement-plan-store.ts), [rules](../../apps/api/src/engagement/plans/engagement-plan.rules.ts), [access](../../apps/api/src/engagement/plans/engagement-plan-access.ts). Use the immutable commit supplied in the publication receipt; do not substitute a moving branch head as an accepted implementation pin.

## 1. Transport, scope and success statuses

All paths below include the existing global `/api` prefix. Existing authenticated tenant/actor context and `RolesGuard` / `standard_user` floor remain. Resource transactions recheck active tenant/membership/Clerk identity, unarchived client and exactly the existing unwalled-or-matching-grant access rule. No administrator, creator or account-owner bypass is added. An explicit client only narrows scope; an unscoped list discovers currently permitted client IDs server-side. Client/actor/tenant request fields do not create authority.

Path planId/waveId use the canonical UUID pipe and are lowercased before service forwarding. Successful objects below are the response body directly: no `data`, `result` or `success` wrapper.

| Method and full path                              | Input                                      | Success body                            | Actual success status |
| ------------------------------------------------- | ------------------------------------------ | --------------------------------------- | --------------------- |
| GET /api/engagement/plans                         | ListQuery                                  | ListResult                              | 200                   |
| GET /api/engagement/plans/:planId                 | UUID planId; no admitted query/body fields | Aggregate                               | 200                   |
| POST /api/engagement/plans                        | CreatePlanInput                            | CreationResult with create_plan receipt | 201                   |
| PATCH /api/engagement/plans/:planId               | UUID planId + PatchPlanInput               | Aggregate                               | 200                   |
| POST /api/engagement/plans/:planId/waves          | UUID planId + CreateWaveInput              | CreationResult with create_wave receipt | 201                   |
| PATCH /api/engagement/plans/:planId/waves/:waveId | UUID planId/waveId + PatchWaveInput        | Aggregate                               | 200                   |
| POST /api/engagement/plans/:planId/waves/reorder  | UUID planId + ReorderInput                 | Aggregate                               | 201                   |
| POST /api/engagement/plans/:planId/reviews        | UUID planId + ReviewInput                  | Aggregate                               | 201                   |
| GET /api/engagement/plans/:planId/history         | UUID planId + HistoryQuery                 | HistoryResult                           | 200                   |

POST status201 is Nest's current default, including review, reorder, no-op reorder and reconciled creation. No HTTP-code override is declared. These routes contain no provider, job, scheduling, recommendation, availability or Meri operation.

## 2. Closed input objects and bounds

The following notation is documentation, not a second exported DTO package. Every normalized body/list/history object rejects unknown fields, arrays/nonobjects, wrong primitive types and invalid nested fields. Omission is allowed only where `?` appears. Explicit null is accepted only where `null` appears. GET detail has no admitted query contract; it does not run a query normalizer. JSON body versions are numbers, not numeric strings.

- `UUID`: accepted UUID string, normalized lowercase. Server-generated plan/wave IDs are UUIDs.
- `Version`: integer number 1 through 2,147,483,647.
- `DateOnly`: real `YYYY-MM-DD` calendar date with a nonzero four-digit year.
- `Instant`: an ISO timestamp string. Response Date values serialize to UTC ISO strings; they are never browser Date objects.
- Titles are trimmed, nonempty strings of at most200 characters.
- OfficeReferenceInput arrays and wave officeTargetIds have at most200 entries; target IDs and office keys may not be duplicated. Reorder has at most1000 unique wave IDs.
- Query limit defaults25, range1–100. List/history accept strictly positive decimal integer query strings or integer values; arrays, zero, signs, fractions and exponent strings are rejected. beforeVersion uses the Version bound.
- A cursor is an opaque nonempty string at most512 characters; only return the received nextCursor. Do not synthesize it from displayed timestamps.

```ts
type OfficeReferenceInput = {
  targetId: UUID;
  officeKey: string;
};

type ObjectiveInput = {
  objectiveId: UUID;
  objectiveVersion: Version;
};

type WaveWindow = {
  startDate: DateOnly;
  endDateExclusive: DateOnly;
  timeZone: string;
};

type ListQuery = {
  clientId?: UUID;
  cursor?: string;
  limit?: number | string;
};

type HistoryQuery = {
  beforeVersion?: number | string;
  limit?: number | string;
};

type CreatePlanInput = {
  clientId: UUID;
  requestId: UUID;
  title: string;
  officeReferences?: OfficeReferenceInput[];
  objective?: ObjectiveInput | null;
};

type PatchPlanInput = {
  expectedPlanVersion: Version;
  title?: string;
  officeReferences?: OfficeReferenceInput[];
  objective?: ObjectiveInput | null;
  action?: 'activate' | 'deactivate' | 'archive' | 'restore';
};

type CreateWaveInput = {
  requestId: UUID;
  expectedPlanVersion: Version;
  title: string;
  formatLabel?: string | null;
  window?: WaveWindow | null;
  officeTargetIds?: UUID[];
};

type PatchWaveInput = {
  expectedPlanVersion: Version;
  title?: string;
  formatLabel?: string | null;
  window?: WaveWindow | null;
  officeTargetIds?: UUID[];
  action?: 'archive' | 'restore';
};

type ReorderInput = {
  expectedPlanVersion: Version;
  waveIds: UUID[];
};

type ReviewInput = {
  expectedPlanVersion: Version;
  reviewDueAt: string;
};
```

Additional exact rules:

- Plan creation defaults omitted officeReferences to[] and objective to null. Wave creation defaults omitted formatLabel/window to null and officeTargetIds to[]. **Creating without office references is supported**; the frontend does not need a new office picker for the initial manual slice.
- officeKey is trimmed, nonempty, max512, and must start `directory:` or `manual:` followed by a nonwhitespace suffix. A UUID suffix is lowercased. This input still must match the existing authorized target's exact current key; a valid-looking label/key grants nothing.
- A wave's target IDs must be a subset of the plan's admitted target IDs. New/changed references are validated against current same-client canonical targets.
- formatLabel is manual display text, max120 after trimming; blank becomes null. It is not an execution enum, eligibility classifier or availability assertion.
- WaveWindow is nullable; when present it is a half-open date-only interval with startDate < endDateExclusive and an explicit valid IANA timeZone, max120, canonicalized through Intl. No start/end instants are invented.
- Plan action cannot be mixed with title/officeReferences/objective in one body. Wave action cannot be mixed with title/formatLabel/window/officeTargetIds. A matching-version body containing no changes is an authorized no-op.
- Reorder must supply **every current unarchived wave exactly once**, excluding archived waves. It is not a partial reorder.
- reviewDueAt must contain a full date, `T`, hours/minutes/seconds, optional1–3 fractional digits, and Z or an explicit `±HH:MM` offset. It normalizes to UTC ISO milliseconds and must be strictly future both at controller validation and after transactional lock waits. There is no default review deadline.
- clientId cannot be patched. Body planId/waveId, tenantId, actor IDs, account-owner fields, independent wave versions and wave execution/status fields are rejected.

## 3. Complete successful receiving shapes

All fields in these response objects are required unless a receipt branch explicitly omits waveId. Arrays may be empty. Nullable fields are present as null. IDs are strings; numbers below are JSON numbers. There are no additional receiving properties beyond the shapes shown.

```ts
type Lifecycle = 'draft' | 'active' | 'archived';

type PlanOffice = {
  targetId: UUID;
  officeKey: string;
  available: boolean;
};

type ObjectiveBinding = {
  clientId: UUID;
  objectiveId: UUID;
  objectiveVersion: Version;
  objectiveRevisionId: UUID;
};

type Review = {
  status: 'unknown' | 'current' | 'stale';
  reason:
    | 'not_reviewed'
    | 'invalid_review_basis'
    | 'plan_changed'
    | 'review_expired'
    | 'review_current';
  checkedAt: Instant;
  meaning: 'explicitly_reviewed_version';
};

type Wave = {
  id: UUID;
  clientId: UUID;
  planId: UUID;
  title: string;
  position: number;
  formatLabel: string | null;
  window: WaveWindow | null;
  officeTargetIds: UUID[];
  archivedAt: Instant | null;
  createdAt: Instant;
  updatedAt: Instant;
  planVersion: Version;
  unavailableOfficeTargetIds: UUID[];
};

type Aggregate = {
  id: UUID;
  clientId: UUID;
  title: string;
  lifecycle: Lifecycle;
  version: Version;
  officeReferences: PlanOffice[];
  objectiveBinding: ObjectiveBinding | null;
  reviewedPlanVersion: Version | null;
  reviewedAt: Instant | null;
  reviewDueAt: Instant | null;
  reviewedByUserId: UUID | null;
  createdByUserId: UUID;
  createdAt: Instant;
  updatedAt: Instant;
  review: Review;
  waves: Wave[];
};

type PlanCreationReceipt = {
  operation: 'create_plan';
  planId: UUID;
  clientId: UUID;
  planVersion: Version;
  requestId: UUID;
};

type WaveCreationReceipt = {
  operation: 'create_wave';
  planId: UUID;
  clientId: UUID;
  waveId: UUID;
  planVersion: Version;
  requestId: UUID;
};

type CreationResult = {
  receipt: PlanCreationReceipt | WaveCreationReceipt;
  reconciled: boolean;
  aggregate: Aggregate;
};

type ClientSummary = {
  clientId: UUID;
  totalPlans: number;
  activePlans: number;
  archivedPlans: number;
  draftPlans: number;
  planIdsOnPage: UUID[];
  complete: true;
  checkedAt: Instant;
};

type ListResult = {
  items: Aggregate[];
  summaries: ClientSummary[];
  pagination: {
    hasMore: boolean;
    nextCursor: string | null;
  };
  completeness: {
    read: 'complete';
    page: 'partial' | 'complete';
    summaryCoverage: 'selected_client' | 'returned_clients';
  };
};
```

Receiving details that must not be renamed or inferred:

- **Aggregate uses id and version**, not planId/planVersion. Wave uses id plus its parent planId and current parent planVersion; there is no independent wave counter. position is a nonnegative integer; do not invent an order field.
- Aggregate includes raw current review metadata **and** derived review. Do not discard the raw nullable fields when validating a closed response.
- Aggregate waves include archived children; archivedAt describes the child's own archive. Parent archive does not rewrite child archive state.
- PlanOffice.available is checked against the current same-tenant/client, unarchived canonical target ID/key pair. False retains the recorded identity without revealing another client's data. unavailableOfficeTargetIds is derived from those current available references. These are office-reference integrity markers, not staff/meeting availability.
- tenantId is excluded from aggregate/wave/snapshot responses. Internal list cursorAt is explicitly stripped by present() and **is not wire data**. No client names, target display labels, current actor field, planId alias or active-plan winner is added.
- List orders plans by created_at then id, ascending, across all lifecycles. It has no archive/lifecycle filter in this version. Cursor timestamp retains internal database precision; public timestamp serialization is not a cursor reconstruction contract.
- Each summary's counts cover all plans for that admitted client, while planIdsOnPage covers only the current returned page. complete:true qualifies those counts, not an enumeration of every permitted client.
- With explicit clientId, summaryCoverage is selected_client and a zero-plan client receives its zero summary. Without it, summaryCoverage is returned_clients: **only clients represented on this page receive summaries**. It is not a permitted-client catalog and does not enumerate zero-plan clients. An unscoped empty page proves no page items, not zero plans for every possible selected client.
- completeness.read is complete on successful list reads; page is partial when hasMore is true. A failed request throws an HTTP error rather than returning an invented success/degraded envelope. Office-reference unavailability remains independently visible within a successful aggregate.
- Multiple plans and multiple active plans for one client remain distinct. Neither first-item selection nor mixed freshness collapse is a service contract.

## 4. History has a different snapshot shape

History is authorized against the **current** parent/client/access context. It returns revisions newest version first; beforeVersion is exclusive. Its top-level planVersion is the current aggregate version, while each item.version and snapshot.version describe that historical revision.

```ts
type HistoricalWaveSnapshot = {
  id: UUID;
  clientId: UUID;
  planId: UUID;
  title: string;
  position: number;
  formatLabel: string | null;
  window: WaveWindow | null;
  officeTargetIds: UUID[];
  archivedAt: Instant | null;
  createdAt: Instant;
  updatedAt: Instant;
};

type HistoricalPlanSnapshot = {
  id: UUID;
  clientId: UUID;
  title: string;
  lifecycle: Lifecycle;
  version: Version;
  officeReferences: PlanOffice[];
  objectiveBinding: ObjectiveBinding | null;
  reviewedPlanVersion: Version | null;
  reviewedAt: Instant | null;
  reviewDueAt: Instant | null;
  reviewedByUserId: UUID | null;
  createdByUserId: UUID;
  createdAt: Instant;
  updatedAt: Instant;
  waves: HistoricalWaveSnapshot[];
};

type HistoryItem = {
  version: Version;
  operation: string;
  actorUserId: UUID;
  createdAt: Instant;
  snapshot: HistoricalPlanSnapshot;
};

type HistoryResult = {
  planId: UUID;
  clientId: UUID;
  planVersion: Version;
  items: HistoryItem[];
  pagination: {
    hasMore: boolean;
    beforeVersion: Version | null;
  };
  completeness: 'partial' | 'complete';
};
```

Historical snapshot review fields are raw stored metadata; **there is no derived review object**. Historical waves contain neither planVersion nor unavailableOfficeTargetIds. Do not validate a history snapshot with Aggregate/Wave schemas or invent those properties.

Stored snapshot officeReferences originally contain targetId/officeKey. History receiving replaces them with PlanOffice by checking availability **now, during this history request**. available is not evidence that the target was available at the revision date. No per-reference availability timestamp or historical availability claim is returned.

History operation is emitted as a string. Current producers are exactly create_plan, activate, deactivate, archive, restore, edit_plan, create_wave, edit_wave, archive_wave, restore_wave, reorder_waves and review_plan; no external execution operation is produced. Revision actorUserId is historical actor identity, not a new authority grant. Items omit a revision-row ID and do not expose tenantId/request hash.

pagination.beforeVersion is the last returned item's version only when hasMore is true; otherwise null. An empty successful page is valid. Neither partial nor failed history is a complete audit-history claim.

## 5. Versions, reconciliation and manual review

Every real plan/child/lifecycle/review change uses expectedPlanVersion and atomically advances the parent version. Authorized matching-version no-ops do not increment it or renew review. Version checks precede no-op decisions. Archived plans remain readable/history-readable; ordinary authoring, wave mutation and review require restoration first.

Lifecycle transitions: activate draft→active; deactivate active→draft; archive draft/active→archived; restore archived→draft. Already-achieved activate(active), deactivate(draft), archive(archived) and restore(draft) are same-version no-ops after authorization/version checks. Other transitions conflict. Restoring a parent preserves explicitly archived child state; no sibling plan is modified.

Creation reconciliation is scoped by authenticated tenant, immutable client, current actor user ID, command and requestId, with a SHA-256 of the normalized payload. Wave creation additionally hashes the canonical parent planId; its original expectedPlanVersion is part of that normalized payload. Keep that exact original payload for an intentional reconciliation; substituting a refreshed expected version changes the hash.

- Current authorization is rechecked before receipt lookup. For wave creation, a same-request/same-payload receipt is returned before rejecting the old expected version or current parent lifecycle. That returns the existing creation result, not a new child or an authorization bypass.
- receipt.planVersion is the **original creation version**. aggregate.version is the **current authorized aggregate version** and may be newer, including an archived parent. reconciled:true identifies that replay; false identifies new creation.
- Plan receipt has no waveId property; wave receipt requires it. Neither receipt returns the internal actor/tenant/hash fields.
- Only plan/wave creation has this retained command-receipt reconciliation. Other writes return Aggregate and history. A timeout, connection loss, aborted readback or 5xx is not proof that a mutation did not execute. Keep an explicit uncertain state; re-read/reconcile and never automatically replay writes.
- Validate response identity against the selected client, plan, child, command and request before UI success. Generic frontend409/reload fallback remains supported; this wire document does not allocate a typed error projection.

Review is a manual statement about the explicitly reviewed aggregate version, not external verification. An explicit future review increments V→V+1 and stores reviewedPlanVersion=V+1, reviewedAt, reviewer user ID and reviewDueAt atomically. Every later real aggregate change invalidates that exact version basis; expiry still applies without an edit.

| Condition, evaluated by rules in this order                                    | Derived status / reason        |
| ------------------------------------------------------------------------------ | ------------------------------ |
| reviewedPlanVersion or reviewDueAt is null                                     | unknown / not_reviewed         |
| Invalid basis/version/deadline, or reviewedPlanVersion exceeds current version | unknown / invalid_review_basis |
| checkedAt >= reviewDueAt                                                       | stale / review_expired         |
| reviewedPlanVersion differs from current version                               | stale / plan_changed           |
| Matching version and future deadline                                           | current / review_current       |

meaning is always explicitly_reviewed_version. Parent archive changes version, so a prior reviewed basis becomes stale; restore does not revive it. No age threshold, profile/Objective/target external-change verification, wave execution, ranking, free-week or meeting-availability assertion follows from review.

## 6. Error receiving

Plan-owned coded errors have the exact body `{ code: string, message: string }`; status is the HTTP status, not another field added to that body. Unknown/unexpected errors are not relabeled as input or lifecycle errors.

| Status | Plan-owned code / current cause                                                                                                                                                                    |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | PLAN_INPUT_INVALID: strict normalization, invalid list cursor, invalid current-wave reorder set/subset or review deadline. Bad path UUID is Nest's ordinary Bad Request body, without a plan code. |
| 404    | Missing/foreign/denied plan/client/wave/Objective or archived client: nondisclosing Nest Not Found body, without a plan code. An accessible archived plan itself remains readable.                 |
| 409    | PLAN_VERSION_CONFLICT: expected aggregate version changed.                                                                                                                                         |
| 409    | PLAN_CREATE_REQUEST_CONFLICT: scoped requestId reused with a different normalized payload.                                                                                                         |
| 409    | PLAN_SCOPE_CHANGED: opaque list cursor was issued for a different current permitted scope.                                                                                                         |
| 409    | PLAN_INVALID_LIFECYCLE: unsupported transition or edit/review of an archived parent/child.                                                                                                         |
| 409    | PLAN_OFFICE_UNAVAILABLE: new/changed office reference no longer matches an available canonical target.                                                                                             |
| 409    | PLAN_OFFICE_REFERENCE_IN_USE: removing a parent target still referenced by any child, including archived children.                                                                                 |
| 409    | PLAN_OBJECTIVE_VERSION_CONFLICT: supplied exact Objective revision is stale.                                                                                                                       |
| 409    | PLAN_VERSION_LIMIT: aggregate cannot advance beyond2,147,483,647.                                                                                                                                  |
| 409    | PLAN_WAVE_ORDER_LIMIT: appending a child would exceed the position bound.                                                                                                                          |

String-based BadRequestException cases (invalid Objective binding or malformed persisted office references), standard guard/context failures and path UUID failures use the existing Nest body `{ message: string | string[], error: string, statusCode: number }`, with no promised plan code. Existing authentication can return401, role guard403; current resource checks can refuse404. Do not use message text to infer resource identity or mutation disposition.

The existing configured Prisma filter also retains its closed `{ statusCode: number, message: string }` error body, including400 invalid parameter,404 not found,503 database capacity and500 internal error. Unhandled failures retain generic500 behavior. These existing infrastructure responses are not success/partial/empty plan results. Error bodies carry no current plan version or hidden target/client metadata.

Frontend integration may retain the existing safe generic409/reload handling and omit office references on creation. It must not add a new office selector, shared-error projection, execution status, recommendation or Meri dependency merely to receive these objects.

## 7. Source snapshot hashes

These SHA-256 values identify the exact local source bytes used to write this receiving map. They are not a final accepted commit/qualification receipt; reseal them if implementation review changes a source file.

| Source                                                       | Bytes | SHA-256                                                          |
| ------------------------------------------------------------ | ----: | ---------------------------------------------------------------- |
| apps/api/src/engagement/plans/engagement-plans.controller.ts |  3768 | 469a72b31e1d6e53ffcb81ec33e4185af9b8471a2e147404d854daaafff41ac3 |
| apps/api/src/engagement/plans/engagement-plans.service.ts    | 19981 | 4e19c284968d36d31982e8dc2b0ddc9317f02e4ea5010027a24121b67ff05c82 |
| apps/api/src/engagement/plans/engagement-plan-store.ts       |  8985 | ea132ac4ce3329520c0702ced263e750c4efad157caef17f2df13f9908321bf3 |
| apps/api/src/engagement/plans/engagement-plan.rules.ts       | 14660 | ed2cd05c9652622822bdfeab267281575cd4b7f21f149fa1f3df448e09516a40 |
| apps/api/src/engagement/plans/engagement-plan-access.ts      |  7033 | 63a2f5de8294d0353976f14ff9f1a5489959e10102a0f523525e967332cef6e0 |

Only WIRE.md is authored in this task slice. No additional tests are started; the parent's single-process qualification is separate. Final implementation pin, test receipt and review disposition remain the publishing owner's handoff requirements.
