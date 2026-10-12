# Planner task creation receipt — bounded scope before implementation

Base: `4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace`. Isolated branch:
`codex/planner-create-receipt-20261012`. Source scope was reported to the parent
before implementation. No root or nested AGENTS.md, implementation-standards file
or .agents skill exists in this backend checkout; the frontend implementation
standards were read for ownership/modularity guidance. No frontend source is edited.

## Existing owner and boundary

`api-strategy/PlannerService.saveTask` and `SpPlannerTask` own the unified Modules
Planner task: raw Clerk assignee identities, project ACLs, field validation, rules,
versions, date-only `dueOn`, optional `dueTime` plus IANA `timeZone`, and internal
activity/inbox records. `api/EngagementService.createTask` owns a distinct Engagement
follow-up with Core UUID identities; it is not a second implementation of Planner.
Core client activity remains a separate owner. The existing task-import receipt is
specific to CSV import and is not reused as a public Quick log command.

Add only `POST /strategy-api/planner/task-create-commands` with UUID `requestId` and
existing partial task `data`, and `GET /strategy-api/planner/task-create-commands/:requestId`.
The create command delegates to existing task validation and persistence. A private
`SpPlannerResource` receipt kind records the scoped request, payload hash and task ID
in the same Planner transaction as task/events/inbox. The existing tenant advisory
write lock serializes duplicate create commands. No schema or migration is needed.
The immutable public receipt is `{requestId, status:'completed', taskId}`; it is not
a cached task view. Call the existing task read API for current details/version.

Request keys are scoped to authenticated tenant and raw Clerk actor; body tenant,
actor, resource kind, version, archive flags and source authority are rejected.
Object-key order does not change the hash; array order and omitted versus explicitly
supplied values remain meaningful. Identical replay returns the same receipt without
repeating task/rule/event writes. Changed data returns409. Current active membership,
task editor access and linked Core record authorization are rechecked on replay and
recovery. Receipt metadata is excluded from generic resource read/write surfaces.
Existing task create/update/import routes and their payloads remain unchanged.

## Acceptance and limits

- One task and one receipt on normal, repeated and interleaved identical requests;
  changed content409, with no duplicate events/inbox/rule effects.
- Receipt persistence failure rolls back the whole Planner write; lost response can
  be recovered through the read-only endpoint without another create.
- Tenant/actor isolation, malformed key/payload, inactive membership, foreign or
  revoked project/assignee access, missing task and revoked linked client/meeting
  authorization fail closed. Generic resource routes do not disclose or mutate receipts.
- Existing task validation, optimistic update/import behavior, date-only round trip
  and explicit timed deadline/DST validation retain their tests.
- Focused synthetic transaction/controller tests and separate TypeScript/build checks.
  Native Prisma/PostgreSQL/RLS contention remains unrun while official native engine
  installation is blocked. No engine/download/checksum bypass, database or provider use.

This is a Planner prerequisite only. It does not choose the Quick log task audience,
add structured commitment direction/objective lineage to Core activity, create a Core
command/outbox, or claim an atomic Core+Planner operation. A future Core orchestrator
must own durable partial states and call this command with the same request ID to
recover remote outcomes. Quick log domain/lineage decisions remain in the backend
ledger. No approval, generation, delivery, billing or deployment path is enabled.

## Canonical date and status clarification from initial tests

The existing Planner scheduler deliberately selects the earlier occurrence in a DST
fold and shifts forward across a gap. The command preserves this tested policy and
does not reject a valid IANA wall time in a gap. Date-only `dueOn` remains the exact
calendar string; the existing derived `deadlineAt` uses end-of-day in task.timeZone
or the service's default zone when null. This candidate does not invent a user zone
or settle Quick log's deadline/reminder semantics. Fresh-task inactive-member
validation retains the existing400; inactive actor receipt replay/recovery is403.
Initial incorrect test assumptions and TypeScript fixture errors remain retained.
