# Phase 1 — Engagement API Local Runtime

## Final implementation posture

Phase 1 adds a second local NestJS runtime on port `4500` that reuses the existing `EngagementModule` and shared database. It does not copy the Engagement source tree, route browser traffic, add infrastructure, create a Phase 1 migration, deploy a standalone service, or change the visible product.

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

## Authoritative acceptance without GitHub Actions

GitHub Actions are unavailable. The merge gate is local and exact-head:

```bash
pnpm verify:engagement-phase-1
pnpm verify:engagement-phase-1:local -- --sha "$(git rev-parse HEAD)"
```

The DB-free command includes portable route/dependency/side-effect manifest freshness checks, exact registry coverage, worker/provider tests, both API builds, API/web typechecks, and the complete web regression suite.

The local command requires:

- a clean checkout whose HEAD contains current `origin/main`;
- an exact SHA matching the checkout;
- an existing authenticated test Clerk session cookie;
- authenticated Chrome/CDP proof with observed `/api/engagement` traffic only to the main API;
- exact auth, role, cross-user, and cross-tenant denials;
- every runtime-registry route returning the stable shadow `503` contract;
- unchanged protected-table digests during denial and background observation;
- host and ARM64 image inspection;
- NC1–NC8 evidence.

It may emit `ENGAGEMENT_PHASE1_LOCAL_COMPLETE` only after every gate passes. Evidence from a different SHA is invalid.

## Non-goals confirmed

- No Phase 1 AWS/CDK/ALB/DNS change
- No standalone-service deployment
- No Phase 1 database migration
- No normal browser routing to port `4500`
- No Recall controller in `engagement-api`
- No worker ownership transfer
- No Outreach V3 or LangGraph
- No visible UI source change
- No merge performed by the implementation agent

## Post-merge boundary

The existing application stack should be deployed normally because shared API code and `main.ts` change. The standalone `engagement-api` service must not be deployed or receive production traffic until the later dark-deployment phase.
