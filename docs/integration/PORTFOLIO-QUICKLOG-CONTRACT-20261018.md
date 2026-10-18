# Portfolio Quick Log field contract

Source base: Core PR86, `b40971b1f8de888687a8fb92fbdf4ff653fe10d3`
(`codex/core-fable-successor-20261018`). Frontend evidence inspected at PR95,
`88088d9ca86dc9c2f8ea9b2e42507348ca7652b1`,
`evidence/figma/decision-and-wiring.md`.

## Canonical routes

The source base already mounts `POST /api/clients/:clientId/activity-commands`,
`GET /api/clients/:clientId/activity-commands/:requestId`, and
`POST /api/clients/:clientId/activity-commands/:requestId/resume`. It already
accepts commitment, explicit `occurredAt`, and commitment/request `dueAt`.
PR95's claim that this Core source has no command route is stale. This fact does
not establish deployed availability or working downstream Planner configuration.

This change extends the existing direct `POST /api/clients/:clientId/activity`
body and the existing command's nested `activity` with the same optional fields:

| Field              | Meaning and validation                                                                                                                                                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `direction`        | `we_owe` or `they_owe`, for commitment/request only. `we_owe` means the logging team owes the obligation to the counterparty; `they_owe` means the counterparty owes it to the logging team. It grants no task ownership or authority. |
| `counterparty`     | User-entered label, trimmed, 1–300 characters. It is not a verified Directory identity. The existing `personId` remains the validated same-client `ClientPerson` reference.                                                            |
| `objectiveId`      | Same-client Objective UUID, supplied with `objectiveVersion`.                                                                                                                                                                          |
| `objectiveVersion` | Integer 1–2147483647, supplied with `objectiveId`, equal to the currently selected Objective version at creation.                                                                                                                      |

Null optional fields mean no detail. A blank counterparty is rejected; omit it
or send null. Direction and counterparty are independent optional fields.
The required activity title remains required. New details are set at creation;
this change does not extend the existing title/body/pin/settle PATCH contract.

Example command (synthetic IDs):

```json
{
  "requestId": "60000000-0000-4000-8000-000000000001",
  "activity": {
    "kind": "commitment",
    "title": "Send the briefing",
    "body": "Send the revised briefing after review.",
    "occurredAt": "2026-10-17T14:00:00-04:00",
    "dueAt": "2026-10-25T17:00:00-04:00",
    "direction": "we_owe",
    "counterparty": "Client legal team",
    "objectiveId": "90000000-0000-4000-8000-000000000001",
    "objectiveVersion": 3
  },
  "followUp": {
    "assigneeUserId": "50000000-0000-4000-8000-000000000001",
    "dueOn": "2026-10-25",
    "timeZone": "America/New_York"
  }
}
```

## Authority and response

Creation calls the existing shared `requireClientObjectiveDestinationRevision`
inside the activity transaction. It checks active tenant/member, exact Clerk and
Core actor identity, standard-user minimum, active client and current client
memory wall; it locks the selected Objective, checks its version and derives its
revision UUID. An unavailable binding returns 404; a stale version returns 409.
This binds a historical revision. It does not require or attest Objective
readiness and does not trigger Meri work.

The server stores details under its own versioned key in the existing activity
metadata column. There is no new table or migration. Callers cannot supply raw
metadata or an Objective revision UUID. A same-key command replay retains the
original activity and receipt even if the Objective subsequently changes. New
omitted fields stay omitted from the command's hash, preserving legacy replay.

Direct create/update responses and recorded timeline rows expose `direction`,
`counterparty`, and `objective`, each null when absent. Raw internal metadata is
not exposed. An Objective value has this shape:

```json
{
  "objectiveId": "90000000-0000-4000-8000-000000000001",
  "objectiveVersion": 3,
  "objectiveRevisionId": "90000000-0000-4000-8000-000000000002",
  "availability": "current"
}
```

`availability` is `current` for the selected current version, `changed` when the
same live Objective has a different version, or `unavailable` after deletion or
loss of its same-client scope. The version/revision remain historical facts.
Reads use the same active-client and client-memory-wall policy as the Objective
owner, rechecked after lookup. Objective ownership is attribution, not a separate
read ACL. A historical link is never permission to open a destination; the owner
route must still authorize navigation. Derived timeline items retain their
existing owner's shape. Command `receiptVersion: 1` and all its fields remain
unchanged; use the canonical activity read to inspect rich details.

## Follow-up boundaries and remaining work

Core commits the activity, metadata and durable follow-up intent together in one
local transaction. The existing Planner call runs afterward as an idempotent
saga with pending, needs-attention, version and same-key recovery semantics.
There is no atomic transaction spanning Core and the remote Planner task.

Custom follow-up title and strategy-step references remain rejected. Planner's
personal task ACL does not continuously follow the Core client wall; the generic
title and empty description avoid copying protected client details. A strategy
reference helper for whole strategies is not proof of a strategy step, and the
current task payload has no authorized step binding. Both extensions require an
owner contract, rather than accepting unchecked identifiers or copied text.

Release still requires the existing command schema, reviewed downstream Planner
task-create-command owner and expected-scope preconditions, HTTPS
`QUICK_LOG_PLANNER_ORIGIN`, and authenticated end-to-end qualification. No live
AWS/SQL, credential, grant, deployment, or paid build was performed here.

## Verification

Local result: **151 tests passed across 10 suites**; scoped TypeScript semantic
and syntax diagnostics: **0** for six changed/new files. Prettier and
`git diff --check` passed.

Focused local tests cover direct HTTP validation and persistence, list access,
Objective admission/version/currentness, read-time wall revocation, old request
hash compatibility, same-key replay after Objective edits, changed-input
conflicts, local rollback, and preservation of generic Planner payloads. Existing
command input/service/HTTP/Planner/independent-review/wall suites also pass.
These use transaction simulators and HTTP mocks; they do not qualify native
PostgreSQL concurrency, RLS or the remote deployment. Scoped TypeScript checking
is limited to the six changed/new TypeScript files and their imported types.
