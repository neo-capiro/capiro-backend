# Engagement Phase 1 Local Runtime — Merge Closeout

GitHub Actions are unavailable for this repository and are **not** an acceptance dependency. Phase 1 is accepted only from one exact, clean, current-main local checkout using the repository-owned closeout commands below.

## Required environment

Docker, Docker Buildx, Chrome/Chromium, Node 20.11+, pnpm 9.12+, and an existing authenticated Clerk **test** actor are required.

Set either the Phase 1 names below or the equivalent `ENGAGEMENT_PHASE0_*` aliases:

```text
CLERK_SECRET_KEY
CLERK_JWT_ISSUER
VITE_CLERK_PUBLISHABLE_KEY
ENGAGEMENT_PHASE1_CLERK_ORG_ID
ENGAGEMENT_PHASE1_USER_CLERK_ID
ENGAGEMENT_PHASE1_USER_EMAIL
ENGAGEMENT_PHASE1_USER_COOKIE
```

The runner does not create a Clerk session or sign-in token. Missing authentication material is a hard failure. Never print or commit these values. Browser-derived bearer tokens live only in temporary mode-`0600` files and are deleted during cleanup.

## Prepare the branch

```bash
git fetch origin
git checkout agent/engagement-api-phase-1-local-runtime
git pull --ff-only origin agent/engagement-api-phase-1-local-runtime
git merge --no-edit origin/main
git status --short
export PHASE1_SHA="$(git rev-parse HEAD)"
git merge-base --is-ancestor origin/main HEAD
git rev-list --left-right --count origin/main...HEAD
```

Expected: a clean tree, a 40-character SHA, and zero commits behind `origin/main`. If merging `origin/main` changes the SHA, push the branch and run every gate against the new SHA.

## 1. DB-free closeout

```bash
pnpm verify:engagement-phase-1
```

This command performs:

- locked dependency installation and required Prisma generation;
- Phase 0 route, external-dependency, and side-effect verification;
- current internal dependency-graph structural checks;
- controller-discovery and exact route-policy coverage;
- controller, service, provider, credential, notetaker, and raw-token boundary tests;
- worker, bootstrap, health, CORS service-identity, and image-entrypoint tests;
- regression suites for the governed Engagement factory and credential resolver;
- both API entrypoint builds;
- API production and web typechecks;
- the complete web regression suite;
- static main-only routing checks;
- syntax checks for every local-closeout script;
- committed-diff whitespace validation.

Required terminal marker:

```text
ENGAGEMENT_PHASE1_DB_FREE_COMPLETE
```

## 2. Authoritative local closeout

```bash
pnpm verify:engagement-phase-1:local -- --sha "$PHASE1_SHA"
```

The root command refuses to run when the SHA differs from `HEAD`, the checkout is dirty, the branch is behind `origin/main`, required tools or credentials are missing, or the Phase 1 diff contains a migration, infrastructure file, or product UI source change.

It executes three mandatory stages.

### Stage A — Full two-process closeout

- disposable PostgreSQL 16 + pgvector database;
- exact checkout migration history applied only to that database;
- deterministic Engagement fixtures;
- main API on `4000`, shadow `engagement-api` on `4500`, web on `5173`;
- health, exact shadow posture, service header, and absent Recall route;
- authenticated Chrome/CDP on Meetings, Outreach, Reports, and Integrations;
- browser traffic only to the main API, never port `4500`;
- manifest-driven read parity;
- exact auth, role, tenant, cross-user, and cross-tenant denials;
- safe shared-database write interoperability;
- every runtime-registry route denied with stable `503` in shadow;
- protected-table stability during denial probes;
- host image and ARM64 OCI inspection;
- serve-only exit `64` for migration and unknown commands;
- NC1–NC8 evidence.

The Stage A marker is provisional:

```text
ENGAGEMENT_PHASE1_LOCAL_COMPLETE
```

### Stage B — Isolated successful-response and real-record proof

A second fresh database and fresh API/web processes are started. The hardened authenticated browser proof is rerun and its temporary bearer token is used to:

- replay every observed Engagement GET and require a real `2xx` response;
- prove representative seeded meeting, contact, outreach, audience, campaign, task, client, report, integration, mail, and attachment reads through both APIs;
- compare normalized bodies and service identity;
- require seeded record IDs on identity-bearing routes;
- classify every primary manifest read as successful or an explicitly approved not-found contract;
- reject matching synthetic `404`s that are not an approved contract.

Required evidence marker:

```text
ENGAGEMENT_PHASE1_POST_ACCEPTANCE_COMPLETE
```

### Stage C — Strict background containment

A third fresh database and shadow runtime are started. JSON-encoded PostgreSQL table digests are compared across at least 65 seconds. The stage requires every disabled-worker log marker and rejects every worker-start marker.

Required evidence marker:

```text
ENGAGEMENT_PHASE1_STRICT_BACKGROUND_COMPLETE
```

Only the root wrapper’s final marker authorizes merge:

```text
ENGAGEMENT_PHASE1_AUTHORITATIVE_LOCAL_COMPLETE
```

Any Stage B or C failure removes `local-runner-summary.json`, so a provisional Stage A success cannot survive.

## Defense-in-depth boundaries

The shadow runtime is protected independently at:

- exact controller/handler route registry;
- `EngagementService` generation, send, transcription, S3, and attachment methods;
- `EngagementAiService` provider-capable methods;
- `LlmCompletionService`;
- AI credential resolution, decryption, and provider validation;
- Microsoft OAuth, Graph sync, subscriptions, notifications, and send;
- Google OAuth, token decryption/refresh, sync, and Gmail send;
- notetaker dispatch/remove, webhook continuation, and reconciliation;
- raw Recall provider methods;
- outreach job and send-intent submission/processing;
- worker startup ownership.

Raw provider tokens are restricted to their definitions and the single guarded module factory by a production-source scan.

## Evidence

Evidence is written to:

```text
.artifacts/engagement-phase1-<exact-head-sha>/
```

Required files include:

```text
local-runner-summary.json
health.json
read-parity.json
auth-parity.json
local-write-interoperability.json
external-action-denials.json
browser-parity.json
post-acceptance-proof.json
background-containment.json
background-containment-strict.json
negative-controls.json
image-inspection.json
screenshots/
logs/
```

The final summary must match the exact PR head and report:

```text
browserResponsesVerified = true
realSeededReadParity = true
strictBackgroundContainment = true
```

Required JSON evidence is scanned for bearer tokens, session cookies, Clerk secrets, and database URLs. Review logs separately before sharing them. Never commit `.artifacts/`.

## Merge gate

Phase 1 is ready for manual merge only when:

- current `main` is an ancestor and the branch is zero commits behind;
- the PR is mergeable;
- `ENGAGEMENT_PHASE1_DB_FREE_COMPLETE` passes on the exact PR head;
- `ENGAGEMENT_PHASE1_AUTHORITATIVE_LOCAL_COMPLETE` passes on that same SHA;
- the final summary SHA equals the PR head;
- Stage B, Stage C, and NC1–NC8 evidence all pass;
- no unresolved P0/P1 review finding exists;
- no Phase 1 migration, AWS, ALB, DNS, standalone-service deployment, port-`4500` routing, or product UI source change exists.

GitHub Actions status is informational only and must not be represented as acceptance evidence.

## Deployment boundary after merge

Deploy the existing Capiro application stack normally because shared API code and `main.ts` changed. Do **not** deploy the standalone `engagement-api` service in Phase 1.

Do not create or deploy an `engagement-api` ECS service, task definition, target group, listener rule, DNS record, service-discovery entry, or autoscaling policy. Do not route production traffic to port `4500`. Phase 1 adds no database migration.

## Rollback

Before merge, stop local processes and discard the branch. After the normal existing-stack deployment, rollback to the prior known-good API/web release if needed. There is no Phase 1 database or standalone-service rollback.
