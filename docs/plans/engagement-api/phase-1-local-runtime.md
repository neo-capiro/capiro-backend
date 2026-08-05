# Phase 1 — Engagement API Local Runtime

## Final implementation posture

Phase 1 adds a second NestJS runtime on port `4500` that reuses the existing `EngagementModule` and shared database. It does not copy the Engagement source tree, route browser traffic, add infrastructure, create a migration, deploy, or change the visible product.

## Fail-closed runtime

The `engagement-api` bootstrap requires the exact shadow matrix before Nest constructs providers:

```text
CAPIRO_SERVICE_NAME=engagement-api
ENGAGEMENT_PROCESS_MODE=shadow
ENGAGEMENT_BACKGROUND_OWNER=disabled
ENGAGEMENT_EXTERNAL_ACTIONS=disabled
ENGAGEMENT_CALLBACKS_ENABLED=false
ENGAGEMENT_RECALL_WEBHOOK_ENABLED=false
```

Boolean controls accept only the exact true and false allowlists. Misspellings fail boot.

An exact controller/handler route registry is authoritative for external actions and the decrypted internal AI-credential route. Colocated decorators are checked against that registry but are not the only runtime protection. All worker `onModuleInit` paths, job submission, send-intent creation, email, LLM, notetaker, attachment, OAuth, sync, callback, and provider-credential boundaries fail closed in shadow.

## Main API parity

Unset main-API controls preserve the existing active behavior. The shared HTTP configurator retains current global-prefix exclusions, CORS behavior, parser ordering and limits, validation, Prisma exception mapping, and server timeouts.

## Local acceptance without GitHub Actions

GitHub Actions are unavailable. The authoritative merge gate is:

```bash
pnpm verify:engagement-phase-1
pnpm verify:engagement-phase-1:local -- --sha "$(git rev-parse HEAD)"
```

The second command requires authenticated Chrome/CDP proof and produces a SHA-bound evidence bundle. It may not skip browser, route, ownership, external-action, background, Docker, or ARM64 validation and may emit `ENGAGEMENT_PHASE1_LOCAL_COMPLETE` only after all gates pass.

## Non-goals confirmed

- No AWS/CDK/ALB/DNS change
- No deployment
- No database migration
- No normal browser routing to port 4500
- No Recall controller in engagement-api
- No worker ownership transfer
- No Outreach V3 or LangGraph
- No visible UI change
- No merge performed by the implementation agent
