# intel-api — Infra / Deploy Wiring Proposal (CTO approval required)

Date: 2026-06-29
Status: PROPOSAL — infra is a hard guardrail. This documents exactly what must be created in
AWS for `apps/intel-api`. Do NOT `cdk deploy` blindly; apply out-of-band like the
meriv2-orchestrator and workspace services.

## What's already in the repo (this branch)
- `apps/intel-api/` — service (build + tests green).
- `.github/workflows/intel-api-image.yml` — builds + pushes the image to ECR on push to main.
- `infra/deploy/intel-api-serve-taskdef.json` — Fargate serve task (port 4300, ARM64).
- `infra/deploy/intel-api-migrate-taskdef.json` — one-shot `prisma migrate deploy` task.

## What YOU must create in AWS (not done by code)

### 1. ECR repository
- `capiro/dev/intel-api` (+ staging/prod). Extend the `capiro-gha-*` OIDC role's ecr-push
  policy to cover this repo path (mirrors the orchestrator note).

### 2. Secrets Manager entries
- `DEEPGRAM_API_KEY` — **use a freshly rotated key** (the one shared in chat is burned).
- `HEARING_ENCRYPTION_KEY` — new 32-byte key (hex or base64). Dedicated, NOT the notes key
  (recommended isolation). Set `HEARING_ENCRYPTION_KEY_VERSION` too if you want versioning.
- Reuse existing `CLERK_SECRET_KEY` + the Aurora credential secret.

### 3. ECS service on the existing capiro-dev cluster
- Register the serve taskdef; create service `capiro-dev-intel-api` (desired count 1+).
- Run the migrate taskdef ONCE before first serve (creates intel_* tables; additive only).

### 4. ALB wiring — WebSocket-specific (the important deltas vs a normal REST service)
- Target group → port 4300, health check path `/health` (ungated, returns 200).
- Listener rule: forward `/intel-api/*` to the target group (prefix NOT stripped — the app
  mounts under `/intel-api`).
- **Raise the ALB idle timeout** well above the default 60s. Live Hearing holds WebSocket
  connections for the length of a hearing (potentially hours). Recommend 4000s (matches
  `MAX_SESSION_MS` headroom). Without this the ALB silently cuts live sessions.
- **Enable target-group stickiness** (load-balancer-generated cookie / connection affinity) so
  a hearing's WebSocket stays pinned to one task across its lifetime.
- The ALB already supports WebSocket upgrade (HTTP/1.1) on HTTPS listeners; no extra setting
  beyond the idle timeout + stickiness.

### 5. Rollback slot
- Keep the previous task-def revision pinned for one-command rollback (mirror the
  api:30 / web:6 / workspace:2 convention; intel-api starts at :1).

## Verification after deploy (prove it, don't assume)
- Running-task imageDigest == ECR `:latest` digest == merge SHA.
- `GET https://<alb>/health` → 200 `{ok:true,service:"intel-api"}`.
- WebSocket connect to `/intel-api/live?sessionId=...` upgrades (101) and stays open > 60s
  (proves the idle-timeout change took).
- Migrate task created the intel_* tables (`\dt intel_*` in psql).

## Env vars consumed by the service (defaults in taskdef)
| Var | Purpose | Default |
|---|---|---|
| `INTEL_PORT` | HTTP/WS port | 4300 |
| `DEEPGRAM_API_KEY` | Deepgram STT (secret) | — required |
| `DEEPGRAM_MODEL` | STT model | nova-2 |
| `DEEPGRAM_ENDPOINTING_MS` | utterance boundary | 300 |
| `HEARING_ENCRYPTION_KEY` | AES-256-GCM transcript key (secret) | falls back to NOTES key |
| `MERIV2_ORCHESTRATOR_URL` | registry base URL for extraction | unset → graceful no-op |
| `MAX_SESSION_MS` | hard session cap | 14400000 (4h) |
| `WEB_ORIGIN` | CORS allow-list | localhost:5173 + capiro.ai |

Note: if `MERIV2_ORCHESTRATOR_URL` is unset, the service still transcribes + persists raw
segments; extraction (entities/quotes/cards) is skipped gracefully until the orchestrator URL is
wired. This lets intel-api deploy and prove live captions before the orchestrator integration.
