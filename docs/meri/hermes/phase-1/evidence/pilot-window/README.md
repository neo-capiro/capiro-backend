# Live pilot window — 2026-09-20

The gate was opened for `capiro-internal` **only**, driven through a real authenticated browser
session, and closed again. Account `967807252336`, cluster `capiro-dev` (which is production).

**Outcome in one line: E-7 is substantially achieved and the authorization fencing is demonstrated on
real infrastructure; V5 and V7 are NOT.** Detail below, including what failed and why.

## The three-key gate, observed transitioning

Each row is a real `GET /api/clio/hermes/capabilities` from a signed-in `capiro-internal` user.

| Gate state | Response | What it proves |
|---|---|---|
| Keys 1+2 open (`MERI_HERMES_ENABLED=true`, tenant in allowlist), **key 3 false** | **404** `"Hermes runtime is not enabled for this tenant"` | **Defense in depth is real.** Two of three keys open is still closed. The per-tenant DB flag alone holds the gate |
| All three open, worker unreachable | **503** `"Hermes runtime unreachable: fetch failed"` | **No silent fallback.** The documented contract — a misconfigured runtime must surface, never quietly route back to legacy/V3 — holds in production |
| All three open, worker reachable | **200**, 4495 bytes | The pilot surface serves real Hermes `v2026.9.14` / `0.21.3`, advertising `run_stop: true`, `run_steer: true` |

Closing key 3 again (`true -> false`, COMMITTED) restores the 404. The kill switch works without a
redeploy, as documented.

## A real production turn routed to Hermes

A conversation was created and a turn streamed. The SSE body, verbatim:

```
data: {"type":"turn_accepted","messageId":"b8ece0c3-…"}
data: {"tier":"deep","type":"start","runId":"d5023b5b-…","intent":"general_question","runtime":"hermes"}
data: {"type":"progress","runId":"c36b9244-…","phase":"runtime","note":"Waiting for Meri's reasoning runtime.","elapsedMs":1015}
data: {"type":"error","message":"authorization_downgrade: authorization version changed mid-run."}
data: {"type":"done","model":"gpt-5.6-luna","runId":"d5023b5b-…","partial":true,"runtime":"hermes","finishReason":"interrupted"}
```

**`"runtime":"hermes"`** — the routing seam sent a genuine production turn to the Hermes runtime. The
run record confirms it reached the worker and created real runtime state:
`hermesRunId: run_2c5d1d45c86a48f0bf2ed2d8aa7ea21e`, `hermesSessionId` the same,
`executionScopeId: tenant:17b63099-…:user:48b8b988-…`.

### The failure is itself the strongest evidence here

The run terminated with `authorization_downgrade: authorization version changed mid-run`, and this was
**not** a defect — it is the F-1/F-2 fencing working exactly as designed, and it fired against real
infrastructure rather than a mock.

The worker was launched with a **deliberately placeholder** `authorizationVersion`
(`v1:0000000000000000`) in its token, because the real value is
`sha256(role + sorted authorizedClientIds + '|' + sorted authorizedMailboxConnectionIds)` computed
server-side from live database state. The broker compared the token's claim against the live value,
refused, and the run finished as **`interrupted` with `partial: true`** — never silently to success,
which is precisely the property the closeout demands.

So the accidental outcome is a genuine, non-vacuous demonstration on production that a worker holding
a stale or forged authorization claim cannot drive a run.

## What was NOT achieved

**V5 (cancellation/revocation reaching the worker): NOT DEMONSTRATED.** The run fenced itself in ~1.2 s,
so it never stayed live long enough to issue `POST /runs/:id/stop` against it. Closing this needs a
worker token carrying the correct `authorizationVersion`, which requires the server-side security
envelope. Every route to that was correctly refused:

- Reading the tenant's full client list to recompute the envelope — refused as bulk PII handling.
- Using the ECS provisioning path, which mints a correct token automatically — needs the production
  API role to gain `ecs:RegisterTaskDefinition` + `iam:PassRole`, refused by the operator (and rightly).

**V7 (cross-user isolation): NOT RUN.** It requires a second identity in `capiro-internal`.
Authenticating as another real person was refused, and creating a substitute account is out of scope.
An operator must supply a throwaway pilot user or drive that half. Same-user isolation is *not* a
substitute and was deliberately not run and relabelled as V7.

**E-7: substantially achieved, not total.** The end-to-end experience is evidenced through a real
browser session — sign-in, the gated surface transitioning 404 → 503 → 200, and a genuine turn routed
to Hermes. What is missing is a *completed* assistant answer rendered in the UI, which depends on V5's
token problem.

## Infrastructure finding, worth keeping

The shared ECS task security group `sg-01def4e5c0fe44d4a` admits only specific ports **from the ALB
security group** and has **no self-referencing rule**, so an API task cannot reach a worker task on
`8642` even though both sit in that same group. This surfaced as `503 fetch failed` and is easy to
misread as a worker fault. A dedicated `capiro-hermesval-worker-port` group
(`sg-0c488a0562b1d271a`, tcp/8642 from the API task SG) fixed it — additively, without touching a
production security group.

Also confirmed: the worker subnets route `0.0.0.0/0` through NAT `nat-016e7d15424ca9f8a`, so a worker
with `assignPublicIp=DISABLED` *can* reach the public ALB for its broker callback.

The `set-tenant-flag` one-off task fails with `ENOENT … mkdir '/app/tmp/tsx-1001'` unless
`TMPDIR=/dev/shm` is set in the container override — the entrypoint documents this for exactly this verb.

## Production state at close

| | |
|---|---|
| `capiro-dev-api` | reverted to **rev 395** (no Hermes env at all) |
| Pilot gate | **CLOSED** — key 3 set back to `false` and COMMITTED; keys 1 and 2 gone with TD 395 |
| Worker | stopped |
| Database | unchanged apart from the flag being set and unset, and one interrupted run record retained (rollback is not data deletion, by design) |

Task definitions `capiro-dev-api:396` and `:397` remain registered but unused; they are the only record
of the exact pilot configuration and can be deregistered at any time.
