# Phase 1 — Engagement API Local Runtime

## Base SHA

`68102d6453ec893100fbc314b2b40cca442ca168` (Phase 0 branch tip — Phase 0 not merged to main)

## Phase 0 prerequisite

- **Accepted:** Yes (branch `agent/engagement-api-phase-0-baseline`)
- **Verifier:** `pnpm verify:engagement-phase-0` — PASS
- **Route count:** 110 routes across 6 controllers
- **Timer count:** 5 OnModuleInit timers
- **External-action route count:** All routes classified by Phase 0 manifest

## Drift from plan

Phase 0 was not merged to `origin/main`. The Phase 1 branch was created from the
Phase 0 branch tip (`68102d64`) instead of `origin/main` (`71aa010a`). This
carries the Phase 0 artifacts forward so the prerequisite verifier passes. The
diff between `origin/main` and the Phase 0 branch tip is exactly the Phase 0
commits (14 files added, 2 modified). No main-only changes are lost.

## Current main bootstrap behavior

- `main.ts` creates `AppModule` via `NestFactory.create`
- Global prefix: `api` (excluding `health` and `webhooks/*`)
- CORS registered before body parsers
- Clerk raw body on `/webhooks/clerk` (1mb)
- Recall raw body on `/webhooks/recall` (1mb)
- Email-signature large body on `/api/me/email-signature` (32mb)
- Default JSON parser (1mb)
- `ValidationPipe` (whitelist, forbidNonWhitelisted, transform)
- `PrismaClientExceptionFilter`
- Port: `API_PORT` default `4000`
- Host: `API_BIND_HOST` default `0.0.0.0`
- `keepAliveTimeout`: 305000
- `headersTimeout`: 310000

## Current main runtime defaults

```
CAPIRO_SERVICE_NAME=api
ENGAGEMENT_PROCESS_MODE=active
ENGAGEMENT_BACKGROUND_OWNER=api
ENGAGEMENT_EXTERNAL_ACTIONS=enabled
ENGAGEMENT_CALLBACKS_ENABLED=true
ENGAGEMENT_RECALL_WEBHOOK_ENABLED=true
```

## Phase 1 non-goals

- No deployment to Fargate
- No ECR, target group, ALB rule, or DNS change
- No preview-header routing
- No Recall webhook registration in the new app
- No worker ownership transfer
- No test sending, real sending, or generation enablement
- No Outreach V3 or LangGraph
- No extraction of shared dependencies from Engagement
- No removal of Engagement from the main API
- No web app change
- No database migration

## Architecture

### Runtime clone

The engagement-api process reuses the existing `EngagementModule` source tree
without copying it. A second NestJS bootstrap (`engagement-main.ts`) creates an
`EngagementApiAppModule` that imports `EngagementModule` directly.

### Second bootstrap

`engagement-main.ts` uses the shared `configureApiHttpApp` configurator with:
- `serviceHeader: 'engagement-api'`
- `includeClerkRawBody: false`
- `includeRecallRawBody: true` (parser configured, no handler registered)
- `includeEmailSignatureLargeBody: false`
- `defaultJsonLimit: '1mb'`

Listens on `ENGAGEMENT_API_PORT` (default 4500) at `ENGAGEMENT_API_BIND_HOST` (default 0.0.0.0).

### Shared source

Both `main.ts` and `engagement-main.ts` call `configureApiHttpApp` from
`apps/api/src/bootstrap/configure-api-http-app.ts` for identical pipeline
ordering, CORS, parsers, ValidationPipe, and Prisma filter.

### Shared database

Both processes use the same PostgreSQL database. No dual-write layer, no second
database. The engagement-api performs tenant-scoped reads and safe local writes
against the shared schema.

### Local ports

```
main API        http://127.0.0.1:4000
engagement-api  http://127.0.0.1:4500
web             http://127.0.0.1:5173
```

## engagement-api posture

- **Service name:** `engagement-api`
- **Process mode:** `shadow`
- **Background owner:** `disabled`
- **External actions:** `disabled`
- **Callbacks:** `false`
- **Recall:** `false` (unregistered)

## Background-process containment

Every Phase 0 timer (`on_module_init` + `setInterval`) consults
`EngagementRuntimePolicyService.backgroundWorkersEnabled()` before starting. In
shadow mode, no timer is created and a sanitized "disabled by runtime policy"
message is logged.

Direct tick/sweep methods call `assertBackgroundOwner` so accidental invocation
through an internal path also fails closed.

Contained timers:
1. `EngagementSyncSchedulerService` — mailbox/calendar sync scheduler
2. `OutreachJobService` — async outreach generation/send worker
3. `OutreachSendIntentService` — durable send-intent delivery worker
4. `NotetakerService` — notetaker reconciliation sweep
5. `AiCredentialResolverService` — credential warmup (SE-022, no external call)

## External-action containment

### Controller guard

`EngagementRuntimeGuard` is registered as a global `APP_GUARD` in
`EngagementApiAppModule` only (never in `AppModule`). It reads
`@EngagementRuntimeAction` metadata and calls `assertExternalAction` /
`assertCallbacksEnabled` before the controller body.

### Service-boundary defense

- `EngagementMailSender.sendMail` asserts `outreach_send`
- `LlmCompletionService.complete` asserts `outreach_generate`
- `NotetakerService.dispatch` asserts `notetaker_dispatch`
- `NotetakerService.remove` asserts `notetaker_remove`
- `OutreachJobService.submit` asserts `outreach_generate` or `outreach_send`
- `OutreachSendIntentService.createIntent` asserts `outreach_test_send` or `outreach_send`

### Stable error shape

```json
{
  "statusCode": 503,
  "code": "ENGAGEMENT_EXTERNAL_ACTION_DISABLED",
  "action": "<action>",
  "message": "This action is disabled in the engagement-api shadow runtime."
}
```
