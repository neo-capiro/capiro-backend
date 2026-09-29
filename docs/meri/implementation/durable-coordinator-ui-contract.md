# Durable research coordinator UI contract

Status: backend contract v1 for the durable-coordinator branch. The separate UI assignment may implement against these authenticated API routes. This document does not claim File 01-C UI readiness.

## Ownership and authentication

The API research service is the sole lifecycle owner. Every route below uses the existing authenticated tenant/user context and current client/conversation authorization. The browser sends its normal fresh server-issued Authorization header per request. It must not persist a bearer token, lease epoch, or server authority envelope in local storage.

`researchId` is the stable durable job identity. `run.id` is the current fenced worker-attempt identity and may change after worker loss; `run.leaseEpoch` increases. Reconnect never creates another research session.

## Versioned DTOs

All new request and response bodies have `version: 1`. Unknown versions fail with HTTP 400. Timestamps are ISO-8601 UTC strings. Event and inbox sequences are non-negative integers ordered within one research session.

### Coordinator snapshot

`GET /api/clio/research/:researchId/coordinator?afterSequence=<n>`

Response:

```json
{
  "version": 1,
  "researchId": "uuid",
  "run": {
    "id": "opaque attempt id",
    "leaseEpoch": 3,
    "eventSequence": 18,
    "phase": "research",
    "status": "running",
    "stage": "Reading House bill text",
    "startedAt": "2026-09-28T12:00:00.000Z",
    "heartbeatAt": "2026-09-28T12:00:10.000Z",
    "deadlineAt": "2026-09-28T12:30:00.000Z"
  },
  "coordinator": {
    "version": 1,
    "planVersion": 2,
    "goalRevision": 1,
    "goal": {
      "objective": "Assess the bill for the selected client",
      "constraints": ["House version only"],
      "deliverables": []
    },
    "deadlineAt": "2026-09-28T12:30:00.000Z",
    "leaseEpoch": 3,
    "cancellation": { "state": "none" },
    "steps": []
  },
  "events": [],
  "nextSequence": 18
}
```

`events` contains only records with `sequence > afterSequence`, in ascending order. A missing `afterSequence` is equivalent to `0`. The server may retain a bounded event window; if the requested cursor predates it, the response includes `cursorResetRequired: true` and the current snapshot remains authoritative.

`run` is the current public run projection or `null` when terminal/legacy metadata no longer has a readable run. A null run is terminal for UI purposes: retain the coordinator and its truthful effects, and do not offer steering, Stop, or resume. Before coordinator admission, a newly saved `interrupted` run with `readyToStart: true` remains available through the existing research-session recovery response; this endpoint returns HTTP 409 and observation must not start it implicitly.

The public step projection includes stable `id`, `dependsOn`, `goalRevision`, `effect`, `attempt`, `deadlineAt`, `outcome`, and safe source/operation reference identities. It excludes tool inputs, result bodies, bearer credentials, private artifact locators, provider reasoning, fingerprints, and payload hashes.

### Steering

`POST /api/clio/research/:researchId/steer`

```json
{
  "version": 1,
  "requestId": "client-generated idempotency identity",
  "expectedGoalRevision": 0,
  "message": "Use the House version only."
}
```

Success: HTTP 200.

```json
{
  "version": 1,
  "accepted": true,
  "idempotentReplay": false,
  "receipt": {
    "requestId": "client-generated idempotency identity",
    "sequence": 1,
    "previousGoalRevision": 0,
    "goalRevision": 1,
    "message": "Use the House version only.",
    "acceptedAt": "2026-09-28T12:05:00.000Z",
    "state": "pending_safe_boundary"
  }
}
```

Submitting the identical `requestId` and identical body returns the original receipt with `idempotentReplay: true`. Reusing the identity with different content returns HTTP 409. A stale `expectedGoalRevision` returns HTTP 409 with the current revision and no mutation.

Acceptance persists the ordered inbox message once and increments the goal revision before acknowledgment. At the next safe boundary the worker attempt is fenced, incompatible pending work is superseded, and a replacement plan is admitted under the new revision. Old-revision completions cannot publish. Prior committed effects remain visible and are never described as undone.

### Stop

`POST /api/clio/research/:researchId/cancel`

Optional body:

```json
{
  "version": 1,
  "requestId": "client-generated idempotency identity",
  "reason": "User pressed Stop"
}
```

The first successful response persists and returns `run.status: "cancel_requested"`. It does not claim cancellation has already been observed. The UI displays “Stopping…” and polls the coordinator snapshot. Terminal `run.status: "cancelled"` is emitted only after cooperative termination/no-new-dispatch is observed. Prior source receipts, artifacts, proposals, and truthful effect receipts remain visible.

The old empty-body request remains accepted for compatibility; the server creates an idempotency identity for that one request, but new clients should provide one.

### Reconnect and resume

Closing an SSE connection only detaches the observer. It does not call Stop and does not mutate the durable run.

1. Call the coordinator snapshot with the last stored event sequence.
2. If the current run is `running` or `cancel_requested`, continue snapshot/event polling from `nextSequence`; do not create a new research session.
3. If it is `interrupted` and `readyToStart` is true, call the existing authenticated `POST /api/clio/research/:researchId/stream` with header `X-Meri-Research-Resume-Run: <current run.id>`. The API reacquires a new fenced worker attempt and fresh server-side credentials.
4. If terminal, render the saved result and remaining truthful effects. Do not replay a write or create another run to regenerate presentation.

Existing SSE routes remain:

- `POST /api/clio/research/:researchId/plan/stream`
- `POST /api/clio/research/:researchId/stream`

SSE event names remain backward compatible. Durable events add `sequence`, `goalRevision`, and `planVersion` where applicable. The terminal report is persisted before its observer event.

## Error contract

- HTTP 400: malformed/version-invalid body or impossible plan.
- HTTP 404: session or current scope is not visible.
- HTTP 409: stale goal revision, reused idempotency identity, inactive lease, unsafe step order, pending uncertain effect, or concurrent CAS loss.
- HTTP 401/403: normal authentication/service-boundary denial.

No response grants tool, source, client, proposal, or write authority. Those remain server-resolved at each invocation/resume.

## UI assignment acceptance boundary

The later UI owner must implement and test authenticated steer, Stop, detach/reconnect, event cursor recovery, stale-revision conflict, and visible prior-effect retention. This backend contract alone is not full File 01-C readiness.
