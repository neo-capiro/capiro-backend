# Canonical Strategy and Planner Objective destinations

This source slice reuses preserved Objective PR2362 persistence and the corrected
published Outreach resolver PR2402 head
`4a784b58a0d41251ae6d7dea75a9b4858abc8665`, tree
`3e04cc68d00373632d4bc86c935d37e672b2d221`. Main remains
`4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace`. No sender, prospect,
newsletter, calendar or reporting candidate source is merged into this worktree.

## One canonical Objective authority seam

`packages/shared/src/client-objective-destination.ts` contains the existing Core
Objective owner's bounded normalization and transactional authority query.
`ClientObjectivesService.requireDestinationRevisionWithinTx` delegates to this same
helper; Strategy and Planner call it in their own existing resource transaction.
There is no new service, store, schema, migration, network bridge or Core ORM model
in Strategy. The Strategy package declares the existing shared workspace package;
its build/runtime Docker source includes the compiled pure shared package. No
container, native Prisma generation, migration or deployment was run.

The shared input is `{clientId, objectiveId, objectiveVersion}`: two canonical UUIDs
and a positive int32. `normalizeClientObjectiveDestination` rejects invalid service
inputs and normalizes UUID case before any owner's same-client comparison.
`requireClientObjectiveDestinationRevision(tx, actor, input)` also normalizes the
input and returns those fields plus the canonical `objectiveRevisionId`.

The actor is trusted `{tenantId, clerkUserId, userId?}`. Core additionally pins its
already-resolved user UUID. Other owners supply only their authenticated Clerk
subject; the helper resolves it to the actual current Core membership UUID in the
locked same-tenant query. Clerk subjects are never cast to UUIDs, and no actor,
tenant or revision UUID is accepted from destination query parameters.

The helper requires current active tenant/membership with the existing internal
role floor (`standard_user`, `user_admin`, `capiro_admin`), current exact Clerk/user
mapping, a nonarchived same-tenant client, and its actual current wall grant when
walled. Admin roles and resource/Objective ownership do not bypass the wall.
The current nondeleted Objective must belong to that exact tenant/client and have
the requested version; its existing immutable revision must exist in the same
scope. Missing/revoked scope is 404; an otherwise authorized stale version is 409
`OBJECTIVE_VERSION_CONFLICT`; invalid bounded input is 400. Infrastructure errors
propagate; they are not converted into successful authorization or stale data.

Current authority rows and the mutable Objective are locked. The immutable
revision uses ordinary SELECT, retaining PR2362's SELECT/INSERT-only revision
privileges. This incorporates the independently reviewed PR2402 P1 correction;
there is no permission expansion or new grant. Parent/current Objective locks
protect cascade removals while the transaction lives. Row acquisition within the
joined authority query and native client/grant lock ordering remain unqualified;
the existing wall writer is not changed. Native deadlock/availability behavior is
an explicit deployment qualification gate, with errors propagated safely.

## Destination-owner reads

Both routes require `clientId`, `objectiveId` and `objectiveVersion` and return
`Cache-Control: private, no-store`. Existing tenant and feature/context guards
remain in force. Arbitrary kind, URL, actor, tenant, resource or revision claims
are rejected by strict transport validation. Each kind is a literal owned by its
route; each resource UUID is derived from the canonical owner row.

| Kind | Canonical owner route | Additional current resource authority |
| --- | --- | --- |
| `strategy` | `GET /strategy-api/strategies/:id/objective-destination` | Exact same-tenant `SpStrategy.clientId` matches normalized input; nonarchived row is locked with FOR SHARE. Existing strategy writers take the same row lock before editing/restoring/archiving. Return the owner's existing live-plan projection, including its normal live nodes/artifact filtering. |
| `planner_task` | `GET /strategy-api/planner/tasks/:id/objective-destination` | Exact same-tenant unarchived task; current task/project viewer ACL; explicit canonical task `data.clientId` equals normalized input. Reuse the existing Planner tenant advisory lock held by task/project mutations. An absent client, meeting, name, parent or multi-project association cannot infer a client. Existing assignee/collaborator/project-grant policy remains authoritative. |

Each response has `destination: {kind, resourceId, clientId, objectiveId,
objectiveVersion, objectiveRevisionId}` plus the owner's normal `strategy` or
`task` payload. Planner also returns its current `destinationVersion` from the
task's canonical optimistic-concurrency version. The binding is a current
observation, never a bearer capability or durable association. Each open must call
the destination owner again; a browser binding or legacy unbound GET is not
Objective-bound authority. Every replay rechecks current tenant, membership, wall,
Objective revision and owner-specific resource scope. No record is created or
mutated, and no strategy generation/activation, Planner command or outbound send
follows from resolution.

## Dependencies, remaining boundaries and qualification

PR2402 at its corrected exact head is the required source base. Its inherited
PR2362 migration is the operational table prerequisite for all three owners.
Compile the changed shared package before the coordinated Core and Strategy
release. Native permissions, Postgres/RLS/MVCC and lock ordering remain unrun;
synthetic/source/WASM checks are not native acceptance. Dot owns deployment
preparation and qualification.

Newsletter PR2401 is not a base dependency for Strategy/Planner; shared barrel
composition must retain both its saved-revision exports and this canonical helper.
A bounded Workspace saved-revision owner may consume only the exact published
reviewed helper plus its own published saved/current canonical client authority,
with explicit PR2362 table and coordinated-release dependencies. That slice remains
owned separately and is not closed by this source. General free-text Workspace
drafts and durable Objective-bound creation/association remain open. No new
Objective persistence, generic links, abandoned commitment semantics or user-facing
implementation details are introduced. Reporting/EngagementService and all
preserved original candidates remain untouched.
