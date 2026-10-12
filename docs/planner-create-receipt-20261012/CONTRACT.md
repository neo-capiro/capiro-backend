# Durable task creation through the existing Planner owner

## Additive API

`POST /strategy-api/planner/task-create-commands` inherits Planner's TenantGuard and
PlannerContextGuard. Unsupported tenant impersonation remains forbidden. Body:

```json
{
  "requestId": "20000000-0000-4000-8000-000000000001",
  "data": {
    "name": "Follow up",
    "dueOn": "2026-11-01",
    "assigneeId": "user_example"
  }
}
```

`data` is the existing partial Planner task data, validated by the canonical task
owner. The example Clerk subject must resolve to an active tenant member. IDs in
Core's user table are not interchangeable with Clerk subjects. Clients/meetings and
project membership require existing authority. Only requestId/data are accepted at
the command envelope; no tenant, actor, source authority, version or archive fields.
UUID request IDs are normalized to lowercase. Response:

```json
{
  "requestId": "20000000-0000-4000-8000-000000000001",
  "status": "completed",
  "taskId": "30000000-0000-4000-8000-000000000001"
}
```

`GET /strategy-api/planner/task-create-commands/:requestId` returns this same immutable
receipt without writes. Use existing `GET /strategy-api/planner/tasks/:id` for current
task details/version. Receipt completion means the Planner task transaction committed,
not that an activity, approval, external notification or cross-service workflow completed.
Existing `POST /planner/tasks`, `PATCH /planner/tasks/:id`, and CSV import are unchanged.

## Persistence, replay and current authority

The server binds the request to authenticated tenant and Clerk actor. An internal
`SpPlannerResource` row (`kind:task_create_receipt`) contains receiptVersion1, normalized
requestId, SHA256 of canonical JSON data, and taskId. Canonical object-key sorting
uses code-unit order; arrays and omitted/explicit values retain their meanings. The
client cannot write the stored hash or reference. A different actor/tenant can reuse
the same UUID as an independent request; no receipt is disclosed across that scope.
Future orchestrators must preserve both command key and initiating authority.

The existing tenant advisory write lock runs before receipt lookup. A receipt miss
continues through `saveTask` validation/rules and persists task, internal activity,
inbox effects and receipt within the same transaction. This is one Planner database
transaction, not a Core+Planner transaction. No second task service or schema is added.
Receipt lookup uses the existing tenant/kind resource index plus actor/JSON predicates;
no new index or migration is allocated. Native lock/RLS behavior is not yet qualified.

Identical replay returns the original task ID, without another task/rule/event/inbox
write. Changed data returns409 after current authority checks. Replay and GET require
active actor membership, current task editor permission and current client/meeting
authorization for the task's direct Core references via PlannerLinksService.
Project membership continues to use canonical Planner ACLs; this change does not
audit or alter the broader project-to-client authorization contract. Once a task is edited, obsolete submitted links
are not an authorization source; a new command still validates submitted links before
any write. A receipt cannot authorize a revoked task/link. These read checks do not
claim a fence against concurrent cross-service revocation. Canonical link checks on
the command path may run within the existing15s Planner transaction timeout; an error
or timeout aborts the transaction without a partial task/receipt.

A missing/inaccessible receipt or task is404; active-membership and current Core link
refusals use403 on replay/recovery. Fresh task validation retains its canonical400
inactive-assignee/actor response. HTTP errors or lost responses do not prove failure:
query the receipt with the same authenticated context, or replay the identical command.
Never switch keys to work around an unknown outcome. A missing task behind an existing
receipt is unavailable; it is not recreated. Archived tasks retain their receipt when
current authorization still permits it. There is no TTL or generic receipt mutation.
All generic resource list/write/view/template paths exclude the internal receipt kind.

## Date and Quick log boundary

A date-only `dueOn` is preserved as `YYYY-MM-DD`. Timed values require existing valid
wall time and IANA zone fields. Planner's established DST policy chooses the earlier
fold occurrence and shifts forward through a gap. Its existing derived deadline uses
end-of-day in timeZone or the service default when null. This candidate preserves that
behavior; it does not infer the user's zone or settle Quick log overdue/reminder rules.

Core still needs a durable activity-command/outbox/partial-state owner with structured
commitment direction, counterparty and approved objective/strategy lineage. The product
must select the intended task audience (Planner versus Engagement follow-up). A Planner
choice can use this idempotent remote step; it cannot call two unrelated frontend POSTs
atomic. No Core activity, prospect association, ordered owner, objective persistence,
newsletter generation/send, effective-date source or aggregate audience is changed.
