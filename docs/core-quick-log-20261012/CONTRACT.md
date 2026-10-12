# Core activity commands, version 1

Source candidate only. Requires the deliberately allocated migration and the
reviewed PR2395 Planner prerequisite, plus this candidate's expected-scope
preconditions. No migration, deployment or shared-state write was performed.

## Request and ownership

`POST /api/clients/:clientId/activity-commands`

```json
{
  "requestId": "60000000-0000-4000-8000-000000000001",
  "activity": {
    "kind": "call",
    "title": "Follow-up call",
    "body": "Optional private client detail",
    "personId": "40000000-0000-4000-8000-000000000001",
    "occurredAt": "2026-10-11T14:00:00-04:00"
  },
  "followUp": {
    "assigneeUserId": "50000000-0000-4000-8000-000000000001",
    "dueOn": "2026-11-01",
    "dueTime": "01:30",
    "timeZone": "America/New_York"
  }
}
```

All IDs shown are synthetic. `followUp` is optional. Recordable kinds remain
email/call/note/request/decision/commitment. Trimmed title is 1–300 characters;
body is at most 5,000. Optional person is an existing ClientPerson belonging to
this client and tenant. No Directory identifier translation is implied.
`occurredAt` requires an explicit ISO instant with offset and cannot be future;
omission uses Core's time once. Optional `dueAt` is an explicit instant and only
allowed for request/commitment. It does not establish an owed-by-party contract.

Planner remains the personal task owner. Its payload uses the fixed name
`Follow up on logged activity`, empty description, resolved assignee, explicit
schedule, and no client/person/meeting/project association or copied client text.
Core owns the protected relation between activity and task. Engagement tasks are
not duplicated. The optional follow-up is assigned to an active same-tenant Core
member with current client access and a stable Clerk identity. It is not a new
Core task service or an arbitrary Planner mutation proxy.

Planner `dueOn` stays a calendar date. A date requires an explicit IANA zone;
optional `dueTime` is HH:mm. Time or zone without date is rejected. Existing
Planner date rules resolve DST folds to the earlier occurrence and gaps forward.
No date-only commitment is silently converted into midnight or a UTC date.
Unknown fields (including metadata, URLs, objective/strategy-step references,
source IDs, owedBy and caller-provided tenant/actor) are rejected.

## Receipt and recovery

The command response contains `receiptVersion:1`, `commandId`, original
`requestId`, `version`, tenant/client/actor IDs, `status`, bounded `reason`,
`activity:{id,personId,available}`, and either null `followUp` or
`{owner:'planner',requestId,assigneeUserId,state,taskId}`. No activity body, raw
provider response, token or arbitrary URL appears in the receipt. The Planner
request ID is the independent server-generated Core command UUID, never the
browser UUID. The command creates server-owned activity sourceType
`activity_command` and sourceId equal to commandId.

`GET /api/clients/:clientId/activity-commands/:requestId` is read-only. A completed
task destination is disclosed only after the existing Planner receipt GET
confirms its current access and its exact stored task ID. Unavailable/deleted or
differently keyed task references are withheld. A receipt is evidence, not a grant.

`POST /api/clients/:clientId/activity-commands/:requestId/resume` takes only
`{expectedVersion: N}`. A stale version or active attempt conflicts with 409.
Same-key create replay never initiates another remote attempt. Explicit resume
first queries Planner; an ambiguous 404 may be followed by the identical-key,
identical-payload command, which preserves Planner's existing authorization and
deduplication. A 401/403/timeout/5xx does not cause a new key or fallback task.
A previously completed command never creates a replacement task.

| Receipt status | Meaning |
| --- | --- |
| completed | Activity exists and any requested task is currently accessible |
| pending | Durable follow-up intent awaits a new explicit attempt |
| in_progress | Another attempt holds the current 60-second lease |
| needs_attention | Current authority/resource availability or remote outcome needs recovery |

Bounded reasons include `activity_removed`, `person_unavailable`,
`assignee_unavailable`, `planner_unavailable`, `planner_access_denied`,
`planner_rejected`, `planner_receipt_invalid`, `planner_receipt_unavailable`.
Transport uncertainty is not proof that the remote task was not created. Keep
the receipt/request ID; do not submit a replacement browser key to recover it.

Core commits activity and intent together. Remote HTTP runs outside every Core
transaction. Tenant/actor/client-scoped advisory locking serializes command
creation and attempt state; token fencing prevents an older attempt from
overwriting a replacement. If a task is accepted and the local commit/reply is
lost, lease expiry and receipt lookup recover the original task. GET never
repairs storage. No worker stores a bearer or impersonates the original actor.

Authorized legacy activity edits and deletion remain available. Deletion leaves
the command and immutable activity ID; replay never recreates it. Deleted person
or changed association holds follow-up dispatch. Accepted tasks are never
compensated by deletion. A cross-service revocation race cannot be made atomic;
the generic task payload avoids copying protected client details into Planner.

## Authorization, configuration and release gates

Every command operation checks current active Core membership, exact Clerk actor,
minimum standard_user role, active client and existing clientMemoryAllowed policy.
Assignee membership, mapping and wall are checked before dispatch. Core authority
is rechecked after remote work before recording/returning an outcome. Canonical
ClientActivityService list/create/update/remove also enforce the existing wall;
otherwise the legacy timeline could expose newly logged protected content.
This is a bounded client-activity owner correction, not shared auth middleware.

The bridge requires the original bearer and rejects HQ impersonation hints. Its
server-only `QUICK_LOG_PLANNER_ORIGIN` must be an HTTPS origin with no credentials,
path, query or fragment. It appends the existing `/strategy-api/planner/` routes,
disallows redirects, bounds each call to eight seconds and receipt bodies to
4 KiB, and forwards no tenant-selection headers. Missing configuration rejects a
new follow-up before local writes. No configuration value was provisioned here.

Both Planner command verbs optionally accept `x-capiro-expected-tenant-id` and
`x-capiro-expected-actor-id`. If present they must exactly match independently
authenticated Planner context before delegation. They cannot select authority.
Core sends both to detect divergent/cached tenant resolution before a task write.
Calls without these constraints preserve PR2395 behavior.

Release remains gated on separate native PostgreSQL/Prisma concurrency and RLS
qualification, migration review/execution authorization, server configuration,
and separately reviewed frontend receipt handling. Route deployment preparation
through dot. Full commitment direction, Directory identity, objective/strategy
links and rich task visibility remain unclosed product contracts.
