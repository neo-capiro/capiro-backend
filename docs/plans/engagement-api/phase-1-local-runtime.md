# Phase 1 — Engagement API Local Runtime

## Base SHA

Phase 0 branch tip `68102d64` (Phase 0 not merged to main).

## Phase 0 prerequisite

- accepted: yes (branch tip 68102d64)
- verifier: `pnpm verify:engagement-phase-0`
- route count: see engagement-route-manifest.v1.json
- timer count: 5 on_module_init timers (SE-001 through SE-005, SE-013, SE-022)
- external-action route count: 25+ routes annotated with @EngagementRuntimeAction

## Architecture

```
main API        http://127.0.0.1:4000   (main.ts → AppModule)
engagement-api  http://127.0.0.1:4500   (engagement-main.ts → EngagementApiAppModule)
web             http://127.0.0.1:5173   (unchanged, points to :4000 only)
```

Both API processes share the same PostgreSQL database. No dual-write layer,
no second database. The engagement-api performs tenant-scoped reads and safe
local writes against the shared schema.

## Main API behavior

- defaults: active/enabled (unset variables resolve to current-behavior defaults)
- bootstrap parity: shared `configureApiHttpApp` extracted from main.ts
- no route changes

## engagement-api posture

- shadow mode
- background disabled
- external actions disabled
- callbacks disabled
- Recall unregistered

## Background-process containment

Every Phase 0 `on_module_init` timer consults
`EngagementRuntimePolicyService.backgroundWorkersEnabled()` before
`setInterval`. In shadow mode: no timer created, one sanitized log message.

Contained timers:
- EngagementSyncSchedulerService
- OutreachJobService
- OutreachSendIntentService
- NotetakerService
- AiCredentialResolverService

## External-action containment

- `@EngagementRuntimeAction` decorator on controller routes
- `EngagementRuntimeGuard` (global guard in EngagementApiAppModule only)
- Defense-in-depth: `EngagementMailSender.sendMail`, `LlmCompletionService.complete`,
  `NotetakerService.dispatch/remove`, `OutreachJobService.submit`,
  `OutreachSendIntentService.createIntent`

## Route contract and parity

- Same current Engagement HTTP contract
- Same canonical route paths
- Read-route parity tested via engagement-phase1-read-parity.ts

## Auth and tenant parity

Same JWT, role, tenant, and ownership rules enforced on both processes.

## Health and service identity

- `GET /health` on engagement-api returns shadow posture
- `X-Capiro-Service: engagement-api` on every response

## Docker and ARM64 build

- Dedicated `apps/engagement-api/Dockerfile`
- Serve-only entrypoint (refuses migrations, exit 64)
- ARM64 OCI artifact build verified

## Migrations

None.

## Infrastructure

None.

## Web/UI

Unchanged.

## Deployment

Not performed.
