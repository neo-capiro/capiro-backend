# V4 — worker state survives task replacement (PASSED)

Executed 2026-09-20 against AWS account **967807252336**, region us-east-1, ECS cluster **capiro-dev**, under the same operator authorization as V1–V3. **No pre-existing resource was modified.** The only change to an existing resource is an added inline policy on `capiro-hermesval-worker-task` — a role created by this validation effort, not a production role.

## What V4 has to prove

The worker's home is EFS-backed: the image sets `HERMES_HOME=/opt/data` (`docker/hermes-worker/Dockerfile:37`), and `ensureScopeTaskDefinition()` mounts the per-scope EFS access point at exactly `/opt/data`. So persona/profile state, the bundled skill set, and native session state all live on the access point rather than in the task's ephemeral layer. V4 asks whether a **replacement task** picks that state back up.

## The constraint that dictates the design

`RunTask` overrides have **no `volumes` field**. A task's EFS access point is fixed at *task-definition registration* time, so selecting a different scope means a different task definition — one TD family per scope. This is why `ensureScopeTaskDefinition()` exists and why V4 is structured as two runs of one TD rather than two overrides of one run.

## Resources created

| Resource | Identifier | Disposition |
|---|---|---|
| Security group | `capiro-hermesval-efs` — `sg-036302af841a987f6` (ingress tcp/2049 from the API task SG only) | delete after V7 |
| EFS file system | `capiro-hermesval-efs` — `fs-0a641cad57e8bff4e` (encrypted, elastic throughput) | delete after V7 |
| Mount targets | `fsmt-02de5d3a26dc46bba`, `fsmt-07570b6f86a663fd6`, `fsmt-0d61b96c949504fa7` (one per API subnet) | delete after V7 |
| Access point | `fsap-0483357925b9df4fa` — root `/scopes/v4-scope-a`, uid/gid 1000, 0755 | delete after V7 |
| Task definition | `capiro-hermesval-worker-v4a:1` — clone of `capiro-hermesval-worker:5` plus the EFS volume, `transitEncryption=ENABLED`, `authorizationConfig.iam=ENABLED` | deregister after V7 |
| Inline role policy | `efs-client` on `capiro-hermesval-worker-task` (ClientMount/ClientWrite/ClientRootAccess, scoped to this one file system) | delete after V7 |

A **dedicated** EFS was created rather than reusing `capiro-dev-clio`. That file system's security group admits NFS only from the Clio worker's security group, so reuse would have meant widening a production security group — the same reason V1 created a dedicated execution role instead of widening the production one.

## Result: PASS

Both runs used the same task definition and therefore the same access point. Task A was stopped and confirmed `STOPPED` before task B was launched, so this is a genuine replacement, not two concurrent tasks sharing a mount.

| Signal | Task A — `313ce251…` (first boot, empty EFS) | Task B — `854e2f08…` (replacement) |
|---|---|---|
| Bundled skills | `Done: **58 new**, 0 updated, 0 unchanged. 58 total bundled.` | `Done: 0 new, 0 updated, **58 unchanged**. 58 total bundled.` |
| Profile / persona | `reconcile: profile=default **prior_state=None** action=registered` | `reconcile: profile=default **prior_state=running** action=started` |
| Home | `HERMES_HOME=/opt/data` | `HERMES_HOME=/opt/data` |

The two runs differ *precisely* in the way persistence predicts, which is what makes this non-vacuous: on an empty file system the worker seeds 58 skills and finds no prior profile; on the replacement it finds all 58 already present and reports the profile's prior state. Had the mount silently not persisted, task B would have reproduced task A's output exactly.

The 58-skill figure also matches the Phase 0 amd64 count and the V1 arm64 count, so no skill was lost or duplicated across the replacement.

Raw log extracts: [`worker-logs.txt`](./worker-logs.txt).

## Note for whoever runs V5–V7

The `probe` sidecar produced an **empty log stream** (0 events, exit 0) when its command was replaced via `--overrides`, while the same container logs normally when it runs its task-definition command. Do not rely on an overridden probe sidecar for evidence — take evidence from the `hermes-worker` stream, which logs reliably in both cases. Cause not diagnosed; it did not block V4.

Separately, `aws logs get-log-events --output text` dies on this host with `'charmap' codec can't encode character '→'` because worker logs contain a Unicode arrow. Set `PYTHONIOENCODING=utf-8`, or use `--output json`.

ECS Exec is configured on the task definition and the task role, but `session-manager-plugin` is **not installed on this host**, so `aws ecs execute-command` is unavailable here. V4 did not need it.
