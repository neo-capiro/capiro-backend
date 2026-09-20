# V1–V3 — real Fargate platform validation (PASSED)

Executed 2026-09-20 against AWS account **967807252336**, region us-east-1, ECS cluster **capiro-dev**, during an operator-declared maintenance window with explicit authorization. **No existing resource was modified.**

## Resources created (all new, distinctly named)

| Resource | Identifier |
|---|---|
| ECR repository | `capiro/dev/meri-hermes-worker` (immutable tags, scan-on-push) |
| Base image | `base-v2026.9.14-arm64` — `sha256:ae694fa22b874ab030e56888d24c5a787642c4700102ec96bf9c5b9bdeccae2e` |
| Worker image | `v2026.9.14-meri-arm64` — index `sha256:62ad9aef…`, **platform manifest pinned: `sha256:51b41a3b8002bb7524f71be303ebefef2bfeb3d7f0d56d6fc2b480a0181c454f`** |
| Log group | `/capiro/dev/meri-hermes-worker` (30-day retention) |
| Task role | `capiro-hermesval-worker-task` (ECS Exec only) |
| Execution role | `capiro-hermesval-worker-exec` (`AmazonECSTaskExecutionRolePolicy`) |
| Task definitions | `capiro-hermesval-worker:1`–`:5` |

## V1 — the pinned ARM64 image runs on real Fargate: **PASS**

Task `42bc28586a514494bc8d124faf080ebf` reached **RUNNING in 47 s**; ECS reported `ecs.cpu-architecture = arm64`. Inside the container, `uname -m` returned **`aarch64`**. The boot log resolved the Playwright binary as `chrome-headless-shell-**linux-arm64**` and seeded **"Done: 58 new, 0 updated, 0 unchanged. 58 total bundled"** — identical to the Phase 0 amd64 figure.

**First attempt failed and is retained as evidence**: task `0e37ce3c…` stopped after 47 s with `AccessDeniedException: logs:CreateLogStream`. Cause: the reused production execution role is scoped to specific log groups. Resolved by creating a **dedicated** execution role rather than widening the production role's permissions.

## V2 — capability parity against the accepted amd64 baseline: **PASS (exact)**

`GET /v1/capabilities` on arm64 returns a **4099-byte body that is byte-for-byte identical** to the amd64 baseline in `../pinned-build-recheck/capabilities.json`:

```
FULL DOCUMENT IDENTICAL arm64 vs amd64: True
feature-flag differences: NONE
endpoint sets identical: True
run_steer: True | idempotency: {supported, durable, retention_seconds: 86400}
```

Auth is enforced identically: **401 without a bearer token, 200 with one.**

## V3 — first-use startup measured: **PASS**

| Phase | Measurement |
|---|---|
| `RunTask` → `RUNNING` (includes ~949 MB image pull) | **47–48 s** |
| `RUNNING` → `/health` serving | **10–15 s** |
| **Cold total, submission → serving** | **≈ 58–63 s** |

Compare local amd64 warm restarts of 13.6 s / 26.5 s (Phase 0 D3c/D6c) — the Fargate figure includes a cold image pull, which local restarts did not.

## Deviation recorded

`session-manager-plugin` is not installed on the operator host, so ECS Exec was unavailable. Evidence was instead collected by a **non-essential probe sidecar** in the same task (awsvpc shares the network namespace), which interrogates the worker over `127.0.0.1` and writes results to CloudWatch. Two probe iterations returned empty bodies because `wget -q` suppresses output on non-2xx and swallows the body; `wget -S -O-` captured both headers and payload. The empty results are retained in streams `probe/` and `probe2/` rather than deleted.
