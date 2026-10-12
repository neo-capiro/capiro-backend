# Existing saved Workspace revision Objective destination

This bounded read-only slice extends the canonical Workspace VersionsService.
It is based on preserved newsletter PR2401
`3c20f798c731403ffe2bbb6fa75dcb1bbf80bb16` and selectively consumes only the exact
reviewed shared Objective helper from PR2404
`0716767e8b6ff323b2516d166b22edb4d2413e57` plus its additive export. No Objective
persistence, service, store, schema, migration or resource-creation association is
introduced. Workspace still owns no Core ORM models.

## Canonical bounded transport

```text
GET /workspace-api/drafts/:draftId/versions/:versionId/objective-destination
    ?clientId=<UUID>&objectiveId=<UUID>&objectiveVersion=<positive int32>
```

The existing Workspace TenantGuard supplies authenticated tenant and Clerk
subject. The query has exactly three required scalar fields; strict validation
refuses unknown actor, tenant, kind, resource, revision, snapshot or URL claims,
repeated/nested values, malformed UUIDs, and invalid int32 versions. UUID case is
normalized by the canonical owner helpers. The route returns
`Cache-Control: private, no-store`.

A success returns the selected saved snapshot, its exact canonical SHA-256 hash
and `workspace-snapshot-canonical-json-v1` format, original author/kind/save time,
and its existing bounded content projection. It additionally returns:

```json
{
  "destination": {
    "kind": "workspace_saved_revision",
    "resourceId": "<exact canonical WsDocVersion UUID>",
    "draftId": "<its exact canonical parent WsDraft UUID>",
    "clientId": "<canonical current client UUID>",
    "objectiveId": "<canonical current Objective UUID>",
    "objectiveVersion": 3,
    "objectiveRevisionId": "<existing canonical immutable Objective revision UUID>"
  }
}
```

The immutable saved-version UUID identifies the destination; there is no invented
mutable Workspace state-version number. The hash covers the complete selected
saved snapshot, preserving array order and canonical object-key ordering. Live
working-copy text cannot replace the selected revision. The caller must fetch
this bound owner route on every open; a prior binding/hash or an unbound legacy
GET is not Objective-bound authority or a bearer capability.

## Current owner authority in one transaction

VersionsService normalizes bounded input, starts one existing Workspace
transaction, and sets the tenant GUC. It calls the unchanged published PR2401
saved-revision owner seam first. That seam resolves the actual current Core
member UUID from the authenticated Clerk subject, checks active tenant/membership
and the existing internal role floor, current draft owner or active collaborator
read/export rights, exact tenant/draft/version identity, and saved/current canonical
`config.clientId` consistency. It checks and locks the actual nonarchived
same-tenant client and its live ethical-wall grant. Ownership/admin status grants
no wall bypass. No Core UUID is fabricated from the Workspace context.

The returned source client must be nonnull and equal the normalized query client
BEFORE probing Objective authority or version conflicts. Missing canonical
association, changed saved/current client, cross-client query or unreadable source
therefore cannot disclose a stale Objective conflict. Display names never infer a
client. This route supports only the exact PR2401-eligible saved revision subset:
prospect drafts and every immutable source-action origin (research, editorial,
preparation, unknown future types) remain refused; unresolved legacy client hints
remain refused. Existing snapshot/content size and literal-slot limits are retained.
General free-text-only Workspace drafts remain outside this source closure.

The byte-identical PR2404 shared Core Objective owner helper then runs on that
SAME transaction and same authenticated Clerk actor. It rechecks active current
Core membership, client/wall, current nondeleted same-client Objective/version,
and the existing immutable same-scope Objective revision. The live Objective is
locked; the immutable revision uses plain SELECT with its preserved SELECT/INSERT
privileges. It returns the canonical revision UUID. The owner helpers' mutable
row/grant locks remain held until this read transaction finishes.

Unavailable source/Objective/client/member/ACL/lifecycle scope returns 404.
Only otherwise authorized same-client stale Objective authority returns 409
`OBJECTIVE_VERSION_CONFLICT`. Invalid input returns 400. Permission, missing-table,
deadlock, timeout and other infrastructure errors propagate; they are not mapped
to 404, successful stale state, or an automatic retry. Every repeated open rechecks
both owners. A later committed change can invalidate a returned observation.

No draft/version/Objective/task/command/receipt is created or mutated. This route
does not perform newsletter staging, generation, provider calls, uploads, outbound
send, or durable Objective-bound creation/association. Existing staging and
version operations remain intact.

## Exact dependencies and native availability gate

The copied helper Git blob is `767a11ddff2ff43a39cdf572029b40a4976facac`, SHA-256
`a7fafdf28c55cb9af93b2faf5fbb4b824023622cc68b08501e0d367dcf4a5443`.
Byte/hash equality is pinned in the handoff evidence. Compile shared first and
coordinate Core/Workspace release with preserved Objective PR2362 tables/migration
and PR2404's canonical Core delegation. The existing PR2401 saved-version
immutability migration remains required. No new migration or Core ORM ownership
is added here, and no migration/database operation was executed.

A concrete inherited native availability race remains: PR2401's
`apps/api/src/clients/clients.service.ts` `setMemoryAccess` (lines1644–1653 in that
exact head) deletes removed grant rows before updating `clients` when toggling the
wall. Existing readers acquire client SHARE before actual grant SHARE. A reader
holding client SHARE can wait on the writer's grant DELETE, while that writer
waits on its client UPDATE. This can deadlock and abort a transaction fail-closed;
it grants no authorization bypass. Native qualification must exercise exactly
flag-toggle plus grant-removal against simultaneous bound reads/staging, including
error propagation and safe fresh-read retry behavior. No unrelated wall writer
was changed. Joined-row acquisition order, RLS/permissions, MVCC, parent cascade,
revocation and trigger installation remain native qualification gates through dot.
Source/synthetic/type/build success is not PostgreSQL or deployed acceptance.
