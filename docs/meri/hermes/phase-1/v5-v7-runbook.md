# V5 / V7 runbook — everything resolved, ready to execute

Written 2026-09-20. **Nothing here has been executed.** Production is on `capiro-dev-api:395` with the
pilot gate closed. This file exists so the window can be run in one pass without rediscovering
anything.

**V6 is deliberately absent** — it tests the provisioning lifecycle itself and cannot be closed without
granting the customer-facing API role `ecs:RegisterTaskDefinition` + `iam:PassRole`, which was refused.
See `v5-v7-blocked-on-resolver-binding.md`.

## Why no code change is needed

`MERI_HERMES_SCOPE_RUNTIMES` (`meri-hermes-runtime.client.ts:107-129`) is a JSON map
`{"<executionScopeId>": {"url","apiKey"}}`. When set, `forScope()` returns before the worker resolver
is consulted, so the API never calls ECS and needs **no new permissions**.

## Resolved values

| Thing | Value |
|---|---|
| Tenant (capiro-internal) | `17b63099-bc0f-4ac5-b596-496161e9481e` |
| Neo Martinez — app user id | `48b8b988-2f7e-458a-999e-9e476ed70752` |
| Neo — execution scope id | `tenant:17b63099-bc0f-4ac5-b596-496161e9481e:user:48b8b988-2f7e-458a-999e-9e476ed70752` |
| Neo — Clerk user id | `user_3DB9UHz60mRgIUOq5A9fwWqMToF` |
| Jordan Clayton — Clerk user id | `user_3DKTSyI8LhDgUuSOIAfHmoazFs3` (app user id **not** resolved — see §Second identity) |
| Clerk secret | Secrets Manager `/capiro/dev/clerk/secret-key` (leading slash; needs `MSYS_NO_PATHCONV=1`) |
| Model credential | `arn:aws:secretsmanager:us-east-1:967807252336:secret:capiro/dev/openai-api-key-7nAmib` |
| Worker image | `capiro/dev/meri-hermes-worker@sha256:51b41a3b8002bb7524f71be303ebefef2bfeb3d7f0d56d6fc2b480a0181c454f` (arm64 platform manifest) |
| Worker TD template | `capiro-hermesval-worker:5`; EFS variant `capiro-hermesval-worker-v4a:1` |
| Validation EFS | `fs-0a641cad57e8bff4e`, access point `fsap-0483357925b9df4fa` |
| Subnets / SG | `subnet-0e38bd390f8961fef,subnet-0920665f91c905f01,subnet-06db79cd21239de19` / `sg-01def4e5c0fe44d4a` |
| Current API TD | `capiro-dev-api:395` — **the rollback target** |

Identity is read from `GET /api/me` (route is `/api/me`, **not** `/api/users/me`, which 404s) with a
`Bearer` token from `window.Clerk.session.getToken()`. Cookie auth alone returns 401.

## The three gate keys

All three must be open (`meri-hermes-flags.ts`):

1. `MERI_HERMES_ENABLED === 'true'` — env, on the task definition
2. `MERI_HERMES_PILOT_TENANT_IDS` contains the canonical tenant UUID — env
3. `tenants.settings_jsonb.clioFeatureFlags['meri.hermesRuntime'] === true` — **database, defaults false**

Deploy keys 1 and 2 first; the pilot stays closed because key 3 is false. Key 3 is then the
open/close switch and the documented fast kill switch — no redeploy to close. The image entrypoint
exposes `set-tenant-flag` for it.

## Steps

### 1. Start the worker, with the model key injected by reference

Clone `capiro-hermesval-worker-v4a:1`, add a `secrets` block so the credential is never handled in
plaintext, and set the broker wiring:

```
secrets:     [{ name: "OPENAI_API_KEY", valueFrom: "<the openai secret ARN above>" }]
environment: MERI_BROKER_URL, MERI_WORKER_TOKEN, MERI_EXECUTION_SCOPE_ID,
             MERI_HERMES_MODEL=gpt-5.6-luna, MERI_HERMES_PROVIDER=custom,
             MERI_HERMES_BASE_URL=https://api.openai.com/v1, HERMES_EXEC_ASK=1
```

The execution role `capiro-hermesval-worker-exec` needs `secretsmanager:GetSecretValue` on that one
secret — it is a role this validation effort created, so this is **not** a production-role widening.

`RunTask`, wait for RUNNING, then take the task's **private IP** (`attachments[].details[privateIPv4Address]`).
Worker URL is `http://<private-ip>:8642`.

> **Unverified:** whether the worker's subnet can reach `MERI_BROKER_URL` if that points at the public
> ALB. V1–V4 ran with `assignPublicIp=DISABLED` and pulled from ECR, which proves egress to ECR but
> not to the internet ALB. **Check this before assuming the broker callback works** — if there is no
> NAT path, use an internal address for the broker rather than `os.capiro.ai`.

### 2. Register API TD 396

Clone `:395`, keep the image digest `sha256:cc7dc8a1…`, keep `GIT_SHA`/`RELEASE_SHA` = `56d97272…`,
and add:

```
MERI_HERMES_ENABLED=true
MERI_HERMES_PILOT_TENANT_IDS=17b63099-bc0f-4ac5-b596-496161e9481e
MERI_HERMES_SCOPE_RUNTIMES={"tenant:17b63099-…:user:48b8b988-…":{"url":"http://<ip>:8642","apiKey":"<worker key>"}}
MERI_HERMES_API_KEY=<worker key>          # matches the worker's API_SERVER_KEY
MERI_HERMES_BROKER_SIGNING_KEY=<32+ chars, generated>
MERI_HERMES_BROKER_PUBLIC_URL=<broker base the worker can reach>
MERI_HERMES_MODEL / MERI_HERMES_PROVIDER / MERI_HERMES_BASE_URL
```

Deploy and wait for steady state. **The pilot is still closed at this point** (key 3 false). Confirm
that: as a signed-in capiro-internal user, `GET /api/clio/hermes/capabilities` must still 404.

### 3. Open key 3 for capiro-internal only, run the gates, close it

- Open: `set-tenant-flag meri.hermesRuntime --tenant capiro-internal --value true --commit` (60 s flag cache).
- **V5** — submit a run, then `POST /api/clio/hermes/runs/:id/stop` while it is live. Assert the worker
  actually receives it and the run reaches a genuine `cancelled` terminal state, not a silent success.
  Then revoke authorization mid-run and assert the release path refuses (`run_not_live`).
- **V7** — two scopes must not see each other's runs, sessions or artifacts. Cross-scope reads must
  return 404, not 403 (ownership is indistinguishable from absence by design).
- Close: same command with `--value false --commit`. Verify 404s return.

### 4. Teardown

Roll the service back to `capiro-dev-api:395`, stop the worker task, and confirm zero
`capiro-hermesval-*` tasks remain. Leave key 3 false and the allowlist empty.

## Second identity — the one thing that needs a human

V7's real form proves isolation **between two users**. That needs a second identity in
capiro-internal, and I cannot produce one:

- Minting a Clerk session as Jordan Clayton is refused — authenticating as another real person is not
  something I will do, whatever the window.
- Creating a substitute account (e.g. `hermes-pilot-b@capiro.ai`) is also not something I do.

So either an operator creates a throwaway pilot user and hands over its id, or an operator drives
Jordan's half themselves. **Failing that, V7 can only be run same-user** — two conversations/scopes of
one user — which is *weaker than the gate asks for* and must be recorded as such rather than reported
as V7 complete. The distinction matters: same-user isolation exercises scope separation but not the
cross-tenant-user authorization boundary.
