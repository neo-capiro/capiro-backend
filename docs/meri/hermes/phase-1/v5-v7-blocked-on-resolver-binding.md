# V5–V7 — what is actually blocked, and what is not

> **CORRECTION (2026-09-20, same day).** An earlier version of this file claimed **all three** of
> V5, V6 and V7 were blocked, because the API could only reach a worker by provisioning one through
> `MeriHermesWorkerLifecycleService`, which would require granting `ecs:RegisterTaskDefinition` +
> `iam:PassRole` to the production API task role. **That was wrong.** A static escape hatch already
> exists and has since Phase 0. The conclusion below replaces it. The operator's decision not to
> widen the production role was taken on the strength of the incorrect claim — that decision remains
> correct, but it costs **one** gate, not three.

## The escape hatch that already exists

`apps/api/src/meri/hermes/meri-hermes-runtime.client.ts:107-129`

```ts
async forScope(scope: MeriHermesWorkerScopeRef): Promise<MeriHermesRuntimeClient> {
  const raw = this.env.MERI_HERMES_SCOPE_RUNTIMES?.trim();
  if (raw) {
    // ...parse { "<executionScopeId>": { url, apiKey } }
    if (!entry?.url) return this;
    return MeriHermesRuntimeClient.withEnv({ ...url, apiKey });   // <-- returns here
  }
  if (!this.resolver) return this;
  const resolved = await this.resolver.resolveWorker(scope);       // <-- never reached
  ...
}
```

`MERI_HERMES_SCOPE_RUNTIMES` is a JSON map from execution-scope id to `{ url, apiKey }`. When it is
set, `forScope()` returns before the resolver is consulted. `resolveWorker()` has **exactly one**
production call site — line 129 — so with the map set, `MeriHermesWorkerLifecycleService` is never
invoked and **no ECS, EFS or IAM provisioning permission is required at all.**

The file's own comment says so: *"resolve from that static map instead of provisioning anything… The
env var itself IS the explicit flag: nobody sets it by accident, and production task definitions
never set it."* `meri-hermes-full-application.e2e.spec.ts:957` already drives the full AppModule
through this path.

## Corrected status

| Gate | Needs the provisioning path? | Status |
|---|---|---|
| **V5** — cancellation / revocation reaching the worker | **No.** Needs a reachable worker, which the static map provides | **Unblocked** — zero new permissions |
| **V6** — failed-provisioning and orphan cleanup | **Yes.** The subject under test *is* the provisioning lifecycle: a provisioning claim that fails, and the orphaned task it leaves. The static map bypasses exactly the code V6 exists to exercise | **Blocked** |
| **V7** — isolation on real infrastructure | **No.** Two scopes map to two distinct worker URLs | **Unblocked** — zero new permissions |

## What V6 would still cost, and why it was refused

Only V6 needs the API itself to provision. That means `ecs:RegisterTaskDefinition`, `RunTask`,
`DescribeTasks`, `StopTask`, `CreateAccessPoint`, `DescribeAccessPoints` and `iam:PassRole` on
`Capiro-dev-Compute-ApiTaskRole12FAD4A7-szq3QeeZJSCQ` — the role behind all customer API traffic.

`ecs:RegisterTaskDefinition` **cannot be scoped to a resource** in IAM, and combined with
`iam:PassRole` it lets the holder define a task with an arbitrary image and command and run it as any
role it can pass. Scoping `PassRole` to the two `capiro-hermesval-*` roles bounds the blast radius
but does not change the shape of the grant.

That also runs against the rule this effort already adopted (`HANDOVER.md` §4): *"Do not widen the
production role; that is why a separate one was created."* V1 created an entire separate execution
role rather than add one log-group permission.

**Decision (operator, 2026-09-20): do not widen it.** V6 stays open.

## How to close V6 properly in Phase 2

Move provisioning off the customer-facing request path: a separate small task or Lambda with its own
narrow role performs `RegisterTaskDefinition`/`RunTask`, and the API asks it for a URL. The
`MERI_HERMES_WORKER_RESOLVER` port is already the right seam for that — it needs a second
implementation that calls the provisioner, not a redesign. The customer-facing role never gains
escalation-capable permissions, and V6 becomes testable.

Do **not** close V6 by granting the production role the IAM. That trades a durable security property
for one validation checkbox.

## Running V5 and V7

They need the deployed API to carry, for the pilot tenant only:

- `MERI_HERMES_SCOPE_RUNTIMES` — `{"<executionScopeId>": {"url": "http://<worker private ip>:8642", "apiKey": "<worker key>"}}`
- `MERI_HERMES_ENABLED=true` and `MERI_HERMES_PILOT_TENANT_IDS=17b63099-bc0f-4ac5-b596-496161e9481e`
- `MERI_HERMES_API_KEY`, `MERI_HERMES_BROKER_SIGNING_KEY`, `MERI_HERMES_BROKER_PUBLIC_URL`
- The worker task needs `OPENAI_API_KEY` to complete a turn. It exists in the account as the platform
  secret `capiro/dev/openai-api-key` and should be injected through the task definition's `secrets`
  block (`valueFrom`), never as a plaintext `environment` value.

The **third** gate key — `tenants.settings_jsonb.clioFeatureFlags['meri.hermesRuntime']` — defaults
to `false`, so the pilot stays closed even with the two env keys set. That flag is the open/close
switch and the documented fast kill switch; the image's entrypoint exposes `set-tenant-flag` for it.
