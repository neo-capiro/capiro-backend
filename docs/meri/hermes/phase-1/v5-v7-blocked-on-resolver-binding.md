# V5–V7 are blocked by a design decision, not by missing work

**Status: BLOCKED. Decided 2026-09-20 by the operator: do not widen the production API task role.**

This is the finding that closes out V5, V6 and V7 for Phase 1. It is not "we ran out of time" — the
remaining work is cheap. It is that running it requires a production IAM change that this project's
own rules forbid, and the reason it requires that change is a specific line of wiring.

## The wiring that causes it

`apps/api/src/meri/meri.module.ts:169`

```ts
{ provide: MERI_HERMES_WORKER_RESOLVER, useExisting: MeriHermesWorkerLifecycleService },
```

`MERI_HERMES_WORKER_RESOLVER` is a clean port — `resolveWorker(scope) -> { url }`, one method,
declared in `meri-hermes-worker-resolver.port.ts` precisely so the runtime client never imports the
lifecycle service. But there is exactly **one** binding for it, and it is the ECS provisioner. There
is no static/URL resolver, and no env switch selects one. So any API process that serves a Hermes
run must itself hold ECS and EFS provisioning rights — even when the worker it needs is already
running and its URL is known.

## What that means in IAM terms

`MeriHermesWorkerLifecycleService` issues `RegisterTaskDefinition`, `RunTask`, `DescribeTasks`,
`StopTask`, `DescribeTaskDefinition`, `CreateAccessPoint` and `DescribeAccessPoints`, and needs
`iam:PassRole` for the worker's task and execution roles. Those permissions would land on
`Capiro-dev-Compute-ApiTaskRole12FAD4A7-szq3QeeZJSCQ` — the role behind **all** customer API traffic
at app.capiro.ai and os.capiro.ai.

Two of those are the problem:

- **`ecs:RegisterTaskDefinition` cannot be scoped to a resource.** AWS supports no resource-level
  permission for it; the grant is account-wide by construction.
- **`RegisterTaskDefinition` + `iam:PassRole` is a privilege-escalation pair.** Whoever holds both can
  define a task definition with an arbitrary image and command and run it as any role they may pass.
  Scoping `PassRole` to the two `capiro-hermesval-*` roles bounds the blast radius to those roles'
  own permissions, but does not remove the shape of the grant.

The role already holds `ecs:RunTask` and `iam:PassRole` for Senate auto-capture, so there is
precedent for part of this — but not for `RegisterTaskDefinition`, which is the escalation-enabling
half.

This also runs directly against the rule this effort already adopted, recorded in `HANDOVER.md` §4:

> A dedicated execution role exists because the production role is scoped to specific log groups and
> could not write to the new one. **Do not widen the production role**; that is why a separate one
> was created.

V1 created a whole separate execution role rather than add one log-group permission. Granting
account-wide `RegisterTaskDefinition` to close a validation gate would be a much larger concession
than the one that principle was written to prevent.

## Also missing (smaller, but real)

Three secrets do not exist in the production task definition and would have to be created and
injected: `MERI_HERMES_API_KEY`, `MERI_HERMES_BROKER_SIGNING_KEY`, `MERI_HERMES_BROKER_PUBLIC_URL`,
plus model-provider credentials for `MERI_HERMES_MODEL` / `MERI_HERMES_PROVIDER`. The broker URL in
particular must be reachable *by the worker*, which is a network-exposure decision of its own.

## Recommendation for Phase 2

Do not solve this with IAM. Solve it at the seam that already exists:

1. **Add a second binding for `MERI_HERMES_WORKER_RESOLVER`** — a static resolver that returns a
   configured worker URL for a scope. The port is already the right shape for this; it needs an
   implementation and an env switch, not a redesign. V5–V7 could then run against a worker
   provisioned out-of-band (exactly how V1–V4 were run) with **zero** new permissions on the API role.
2. **For the real pilot, move provisioning off the API request path** — a separate small task or
   Lambda with its own narrow role does the `RegisterTaskDefinition`/`RunTask` work, and the API asks
   it for a URL. The customer-facing role never gains escalation-capable permissions.

Option 1 is small enough to be Phase 1 follow-up work and would unblock V5–V7 immediately. Option 2
is the durable answer and belongs in Phase 2 before any tenant is routed to Hermes.

## What this does not block

V1–V4 are all PASS and needed none of this, because each provisioned its worker out-of-band by
direct AWS CLI rather than through the API. The same approach is what makes recommendation 1 work.
