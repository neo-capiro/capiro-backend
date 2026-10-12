# Objective-bound Outreach destination contract

This source slice reuses Objective PR2362 `72bfea4c5f574c2d9dba63c6bbc63dac1c7e377e`
and merges refreshed main `4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace` without
altering either preserved head. There is no new persistence, schema or migration.
The existing Objective migration remains a coordinated release prerequisite.

## Canonical owner and bounded transport

With the existing `OUTREACH_V3_STATE_ENABLED` guard enabled, the existing Outreach
state controller exposes:

```text
GET /api/engagement/outreach-v3/sessions/:sessionId/objective-destination
    ?clientId=<UUID>&objectiveId=<UUID>&objectiveVersion=<positive int32>
```

All three query fields are required. Arbitrary kind, URL, actor, tenant, resource
or revision ID claims are refused by the existing strict validation pipe. This
owner supports exactly one kind, `outreach_session`; the canonical session ID
comes from its own authorized row. The query's version identifies an exact
existing immutable `ClientObjectiveRevision`, whose canonical revision UUID is
returned rather than trusted from the caller. UUID letter case is normalized.

The successful response is the existing session snapshot, Campaign Spec/hash,
readiness and pending proposal count plus:

```json
{
  "destination": {
    "kind": "outreach_session",
    "resourceId": "<canonical session UUID>",
    "clientId": "<canonical client UUID>",
    "objectiveId": "<canonical Objective UUID>",
    "objectiveVersion": 7,
    "objectiveRevisionId": "<canonical immutable revision UUID>",
    "destinationStateVersion": 4
  }
}
```

`Cache-Control: private, no-store` prevents caching this authorization-sensitive
response. A destination binding is an observation of currently authorized
canonical state, never an authorization capability or a durable association.
An Objective UI must fetch this owner route each time it opens a bound session;
reusing a previous binding or fetching the legacy unbound session route does not
establish Objective-bound access. No frontend navigation is activated here.

## Current authority and concurrency

`OutreachSessionService`, the existing session owner, opens its normal
`withTenantUser` transaction and locks its exact tenant/actor-owned session using
the existing repository. The session must be active and have no archive marker.
The existing Objective owner then verifies and locks the current active tenant,
active membership with the established internal role floor, exact UUID/Clerk user
mapping, nonarchived same-tenant client, and the actual ethical-wall grant when needed.
Administrative roles and Objective assignment grant no bypass.

The current nondeleted Objective must belong to that exact tenant/client and its
version must equal the requested version. Its existing immutable revision must
exist under that same tenant/client/Objective/version. Foreign, missing, deleted,
archived, revoked or unavailable scope returns 404; an otherwise authorized stale
Objective version returns 409 `OBJECTIVE_VERSION_CONFLICT`. No historical snapshot
is returned as current destination authority.

The session owner loads and verifies its exact current state version using its
existing parser, digest and sponsor-isolation checks. Sponsor kind must be
`client`, with exactly one client UUID equal to the Objective's canonical client.
Free text, firm, coalition, multi-client and other scopes cannot substitute.
Campaign goal/objective strings are not canonical Objective identity.

The lock stages are session → current authority rows (tenant/membership/user/client
in one joined query) → actual wall grant (when walled) → Objective → revision.
This does not independently qualify PostgreSQL's row acquisition order within the
joined authority query. The owned session lock serializes sponsor edits
and archival; shared authority locks protect current row/grant revocation and
Objective updates until the response snapshot transaction finishes. Every retry
opens a new transaction and rechecks current authority. A later committed change
can invalidate a previously returned observation. No resource, Objective revision,
command, generation, outbound send or receipt is created or mutated.

The implementation reuses `ClientObjectivesService` as a provider in the Outreach
module. It deliberately does not import the controller-owning ObjectivesModule,
which would register unrelated Objective CRUD routes on the Engagement runtime.

## Remaining destination contracts and qualification

This closes only existing Outreach session resolution. Objective-bound creation,
durable associations, Strategy, Planner and Workspace destination kinds remain
separate source work. Workspace free-text `client` is not authority; PR2400's
prospect origin does not itself create an Objective or distribution contract.
Do not introduce generic links, a second Objective store, or cross-owner writes
based on this response. Newsletter staging remains owned by the separate existing
Outreach command bridge and must retain its revision/hash/receipt/CAS contract.

Source/synthetic authorization, replay, transport and canonical-owner regression
checks are recorded in QUALIFICATION.md. Pinned official Prisma WASM/no-engine
generation is local typing evidence only. Native Postgres lock ordering, MVCC,
RLS, database permissions and Objective migration execution remain unrun. No real
provider, customer, AWS, model or deployment operation was performed. Dot owns
coordinated deployment preparation and native qualification.
