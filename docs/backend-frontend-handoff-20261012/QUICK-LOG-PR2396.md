# PR2396: exact frontend contract

Source handoff, 2026-10-12. Nothing here attests deployment, migration execution or
signed-in acceptance. The frontend must review its own receipt validation and
tenant/actor navigation behavior before enablement.

## Pinned source and prerequisites

| Item | Exact source |
| --- | --- |
| Core quick log | [draft PR2396](https://github.com/neo-capiro/capirov2/pull/2396), head `e2c2c110edd986e799d47d43b0db50b24fab0201` |
| Independently reviewed runtime/tests | `961cbe0204d762ddfcb96ec054a907665720380e`, tree `04749f1c520bc68ee5b68b1516b4256c2009cb27`; later changes are documentation/evidence only |
| Planner prerequisite and PR2396 base | [draft PR2395](https://github.com/neo-capiro/capirov2/pull/2395), head `c5e41e320af4b4d841d4b3136777d712116916ed` |
| Main used for these candidates | `4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace` |

The complete prerequisite includes **both Core and Planner changes in PR2396**.
PR2395 alone does not enforce expected-tenant/actor headers. PR2396 adds the
[Planner scope constraint](https://github.com/neo-capiro/capirov2/blob/e2c2c110edd986e799d47d43b0db50b24fab0201/apps/api-strategy/src/planner/planner-command-scope.ts)
and its controller calls; pairing Core PR2396 with unchanged Planner PR2395 would
omit that protection.

Authoritative pinned implementation: [controller](https://github.com/neo-capiro/capirov2/blob/e2c2c110edd986e799d47d43b0db50b24fab0201/apps/api/src/clients/activity-commands/activity-command.controller.ts),
[input normalization](https://github.com/neo-capiro/capirov2/blob/e2c2c110edd986e799d47d43b0db50b24fab0201/apps/api/src/clients/activity-commands/activity-command.input.ts),
[command lifecycle and receipt](https://github.com/neo-capiro/capirov2/blob/e2c2c110edd986e799d47d43b0db50b24fab0201/apps/api/src/clients/activity-commands/activity-command.service.ts),
[authorization](https://github.com/neo-capiro/capirov2/blob/e2c2c110edd986e799d47d43b0db50b24fab0201/apps/api/src/clients/activity-commands/activity-command.access.ts),
[Planner bridge](https://github.com/neo-capiro/capirov2/blob/e2c2c110edd986e799d47d43b0db50b24fab0201/apps/api/src/clients/activity-commands/activity-command.planner.ts).

## Routes and types

All three routes use the existing Core authenticated context and original bearer.
`clientId` and `requestId` are UUIDs. POST responses use Nest's default HTTP 201,
including replay and a receipt needing attention; GET uses 200. There is no
frontend call to Planner required for command creation or recovery.

| Method | Route | Body | Result |
| --- | --- | --- | --- |
| POST | `/api/clients/:clientId/activity-commands` | `CreateActivityCommand` | `ActivityCommandReceipt` |
| GET | `/api/clients/:clientId/activity-commands/:requestId` | none | `ActivityCommandReceipt` |
| POST | `/api/clients/:clientId/activity-commands/:requestId/resume` | `{ expectedVersion: number }` | `ActivityCommandReceipt` |

These TypeScript shapes describe JSON; string types do not replace runtime
validation. Every request object rejects unknown fields.

```ts
type CreateActivityCommand = {
  requestId: string; // Browser-generated UUID, retained for this logical command.
  activity: {
    kind: 'email' | 'call' | 'note' | 'request' | 'decision' | 'commitment';
    title: string; // Trimmed, 1–300 characters.
    body?: string | null; // Trimmed, at most 5,000; empty/omitted -> null.
    occurredAt?: string; // Explicit ISO instant + UTC offset; cannot be future.
    dueAt?: string | null; // Explicit instant; request/commitment only.
    personId?: string | null; // Same-client ClientPerson UUID, not Directory ID.
  };
  followUp?: { // Omit to create only activity; null is invalid.
    assigneeUserId: string; // Core user UUID, not Clerk ID.
    dueOn?: string | null; // YYYY-MM-DD calendar date.
    dueTime?: string | null; // HH:mm.
    timeZone?: string | null; // Explicit IANA zone required when dueOn is set.
  };
};
type ActivityCommandReason =
  | 'activity_removed' | 'person_unavailable' | 'assignee_unavailable'
  | 'planner_unavailable' | 'planner_access_denied' | 'planner_rejected'
  | 'planner_receipt_invalid' | 'planner_receipt_unavailable';
type ActivityCommandReceipt = {
  receiptVersion: 1;
  commandId: string;
  requestId: string;
  version: number;
  tenantId: string;
  clientId: string;
  actorUserId: string; // Core user UUID.
  status: 'completed' | 'pending' | 'in_progress' | 'needs_attention';
  reason: ActivityCommandReason | null;
  activity: { id: string; personId: string | null; available: boolean };
  followUp: null | {
    owner: 'planner';
    requestId: string; // SERVER commandId, not browser requestId.
    assigneeUserId: string;
    state: 'pending' | 'completed' | 'unavailable';
    taskId: string | null;
  };
};
```

Omitted `occurredAt` resolves once at initial Core creation. Omitted `dueAt`,
`personId` and follow-up scheduling fields normalize to null. UUIDs normalize to
lowercase. Explicit instant spellings are not canonicalized to equivalent UTC
spellings: preserve the original submitted payload when retrying. Time/zone
without a date is invalid. The follow-up uses existing Planner DST rules (earlier
fold occurrence, gap shifted forward). A commitment `dueAt` is an instant; there
is no date-only commitment timezone policy in this contract.

## Receipt validation and recovery

Retain the original browser request ID and submitted body before sending. Scope
local pending state to the current tenant, Core actor and client; do not replay it
after a context switch. Validate `receiptVersion`, all discriminants and IDs,
matching browser request ID, tenant/client/actor, and the invariant that the
follow-up request ID equals command ID. A task destination is eligible only when
the freshly returned follow-up has `state: 'completed'` and a non-null task ID.
An available activity and a pending follow-up are separate outcomes.

Core atomically commits activity plus command intent, then calls Planner outside
the transaction. This is a recoverable cross-service command, not an atomic pair
of service writes. Its idempotency scope is tenant + Core actor + client + browser
request ID. The server persists the normalized input hash and freezes the Planner
payload, assignee mapping and separate Planner request key. The activity remains
editable through its authorized API; its original text is not copied into an
immutable command payload.

| Situation | Required interpretation / recovery |
| --- | --- |
| Same create key and normalized body | Returns current receipt; does **not** start another remote attempt. |
| Same key, changed body | 409; retain original command and draft. Do not silently replace its key. |
| Create response lost, 5xx or transport uncertainty | Core and/or Planner may have committed. GET the same command. An authorized exact-body replay can recover initial creation; a nondisclosing 404 does not prove absence or authorize a replacement key. |
| `pending` / `needs_attention` without completed task | Retain receipt and draft. Refresh GET, resolve the reported condition, then explicitly POST resume with latest returned version. |
| `in_progress` / active-attempt 409 | Another attempt holds a 60-second lease. Back off and refresh; lease timestamp is not public. |
| Stale-version 409 | GET latest receipt; never increment a local version and guess. |
| Remote accepted but local receipt commit/reply lost | After lease expiry, resume queries Planner using the same server key; existing receipt recovers the original task. No compensating deletion or new-key task. |
| Previously completed task becomes unavailable | Receipt withholds task ID; no automatic replacement task, including on resume. |
| Activity deleted through authorized legacy API | Receipt survives as a tombstone; replay does not recreate activity. |

`expectedVersion` is an integer from 0 through 2147483646. Version increments are
server-owned; one operation can claim and finalize an attempt and advance it
twice. GET does not write or repair state. A resume GET miss in Planner can lead
to an identical-key, identical-payload Planner POST, but authorization failures,
timeouts and other lookup failures do not trigger an alternate key or fallback.
There is no automatic recovery worker or stored bearer.

`activity.available` means the original activity still exists, not that its
original person association remains valid. Current deletion/person/assignee
issues can make a completed command need attention. Once those conditions clear,
old failure reasons do not override a currently completed receipt. Current
Planner receipt authorization and exact task-ID agreement are rechecked before
revealing a task ID. A receipt is not an ongoing permission grant.

## Authority and entitlements

The caller must have current active tenant membership, a matching Clerk identity,
at least `standard_user`, an existing non-archived client and the existing `clientMemoryAllowed`
wall. Admin role does not bypass that wall. Receipts belong to the original actor;
another tenant/member/client cannot use their keys. Assignee must be an active
same-tenant Core member with current access to this client and the same Clerk
mapping frozen at creation. These checks run again before dispatch; caller
authority is rechecked after remote work. HQ impersonation header presence is
rejected by the Core command controller, including an empty header.

**These routes introduce no subscription, paid-plan or feature-entitlement check
or entitlement receipt.** Checked-in Core global guard/middleware and this
controller apply authentication, role and rate-limit behavior; Planner applies
its existing authenticated context, active membership and task/project ACLs.
Work Planner does not inherit the PPBE Strategy Planner rollout flag. Do not
interpret a 403/404, bridge 503 or `planner_access_denied` as an authoritative
upgrade decision. Existing frontend product/module gating remains separately
owned; this handoff does not attest external gateway policy.

Core sends the original bearer plus expected-tenant and expected-Clerk-actor
constraints to Planner. Planner compares them to its independently authenticated
context; these headers cannot select authority. Do not add tenant-selection or
impersonation headers to this bridge. Server-only `QUICK_LOG_PLANNER_ORIGIN` must
be a configured HTTPS origin; redirects are refused, calls time out after eight
seconds each and receipt bodies are limited to 4 KiB. No value was provisioned.

## Generic follow-up limits

Planner is the sole task owner. The generated task has fixed name `Follow up on
logged activity`, empty description, selected assignee and optional explicit schedule.
It has no client, meeting, project, parent, person, objective or strategy-step
association and no copied client/activity text. Core retains the protected
activity/task lineage. Planner does not continuously enforce Core client walls;
the generic payload limits what a later wall change could expose there.

This closes durable activity + generic follow-up recovery. It does not close
commitment direction/counterparty semantics, Directory identity mapping,
objective destinations, rich task context, per-mailbox signatures, sending email,
or arbitrary Planner task creation. Unknown fields for those features are 400.
Do not show a rich commitment workflow as completed by this candidate.

## HTTP failures versus receipt reasons

Default Nest error envelopes contain `statusCode`, `message` and normally
`error`; there is no new structured error-code enum. Use status plus the retained
command context for recovery; exact message text is diagnostic, not an API code.

| HTTP | Checked-in causes |
| --- | --- |
| 400 | Invalid UUID/input/unknown field; invalid or future occurrence; due instant on unsupported kind; wrong-client person; unavailable initial assignee. |
| 401 | Missing/malformed bearer or existing authentication failure. |
| 403 | Role guard, impersonation header, or existing authorization rejection. |
| 404 | Missing or inaccessible command/client, revoked membership/wall, foreign actor/tenant/client. Deliberately nondisclosing. |
| 409 | Changed payload under same key; stale expectedVersion; active attempt lease. |
| 429 | Existing global throttling; no command-specific rate policy. |
| 503 | Missing/invalid Planner bridge configuration (new follow-up is rejected before local writes); config loss may also affect subsequent reads/replays. The existing Prisma exception filter also maps P2024/P2028 connection/transaction capacity timeouts to 503 with `Retry-After: 2`; retain the command key and reconcile uncertain state. |
| 5xx / transport loss | Uncertain commit state: retain key and recover; never infer that nothing was saved. |

Remote Planner failures normally return a successful Core HTTP response with
`needs_attention`, not an HTTP failure: `planner_unavailable` covers transport/
server failure; `planner_access_denied` covers remote 401/403; `planner_rejected`
covers other non-success client statuses; `planner_receipt_invalid` covers a
missing/oversized body or parsed JSON with the wrong schema/request ID. Invalid
JSON parsing is caught as `planner_unavailable`. `planner_receipt_unavailable` withholds an
already-recorded task that current lookup cannot validate. Current activity,
person and assignee issues use their explicit reason names above. These are
recoverability signals, not claims that a task was never accepted.

## Evidence and remaining gates

[Exact qualification receipts](https://github.com/neo-capiro/capirov2/blob/e2c2c110edd986e799d47d43b0db50b24fab0201/docs/core-quick-log-20261012/QUALIFICATION.md):
independent review 284/284 tests in 15 suites, including 15 adversarial cases;
author Core 128/128 in 10 suites and Strategy 141/141 in seven suites (overlap,
not additive). Primary Core/Strategy TypeScript and Nest builds passed. Initial
failed regression/compile attempts and their fixes remain in evidence.

Migration source `20281012010000_client_activity_commands` was prepared and
reviewed; it has never been executed, even against an ephemeral database. Native
Prisma/PostgreSQL concurrency and RLS remain unqualified. The saved environment's
proxy rejects normal HTTPS CONNECT to `binaries.prisma.sh:443` with Envoy 403
before TLS; no bypass was attempted. The supported next route is environment-owner
approval of that normal egress, normal pinned Prisma download/generation with
checksums intact, then separately authorized disposable native qualification.
ESLint is separately blocked by missing checked-in dependency/configuration.
These are qualification/tooling gates, distinct from this source contract.
Deployment preparation and configuration go through dot. No rollout is enabled.
