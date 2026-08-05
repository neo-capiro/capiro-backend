# Engagement Phase 1 Local Runtime — Merge Closeout

GitHub Actions are unavailable for this repository and are **not** an acceptance dependency. Phase 1 is accepted from one exact, clean, current-main local checkout using the repository-owned closeout commands below.

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

The runner does not create a Clerk session or sign-in token. Missing authentication material is a hard failure, not a skipped browser test. Never print or commit these values. The bearer token derived by the authenticated browser is written to a temporary mode-`0600` file and deleted during cleanup.

## Prepare the branch

```bash
git fetch origin
git checkout agent/engagement-api-phase-1-local-runtime
git merge --no-edit origin/main
git status --short
export PHASE1_SHA="$(git rev-parse HEAD)"
git merge-base --is-ancestor origin/main HEAD
git rev-list --left-right --count origin/main...HEAD
```

Expected: a clean working tree, a 40-character SHA, and zero commits behind `origin/main`.

## 1. DB-free closeout

```bash
pnpm verify:engagement-phase-1
```

This command performs:

- locked dependency installation;
- all required Prisma client generation;
- Phase 0 route, dependency, and side-effect verification;
- portable committed-manifest freshness checks against the current source;
- exact route-policy and negative-control tests;
- worker, provider-boundary, bootstrap, health, and entrypoint tests;
- both API entrypoint builds;
- API production and web typechecks;
- the complete web regression suite, with no supported skip flag;
- static web-routing drift checks;
- committed-diff whitespace validation against `origin/main...HEAD`.

Expected terminal marker:

```text
ENGAGEMENT_PHASE1_DB_FREE_COMPLETE
```

## 2. Authoritative local closeout

```bash
pnpm verify:engagement-phase-1:local -- --sha "$PHASE1_SHA"
```

The command refuses to run when:

- `--sha` differs from `git rev-parse HEAD`;
- the checkout is dirty;
- the branch is behind or diverged from `origin/main`;
- the Phase 1 diff contains a migration, infrastructure file, or product UI source change;
- authenticated browser credentials, Chrome, Docker, Buildx, or a required fixture are unavailable.

It then:

1. runs the DB-free closeout;
2. creates a disposable PostgreSQL 16 + pgvector database and applies the exact checkout's migration history only there;
3. seeds synthetic Engagement fixtures;
4. starts the main API on `4000`, `engagement-api` on `4500`, and the unchanged web app on `5173`;
5. verifies health, exact shadow posture, `X-Capiro-Service`, and Recall `404`;
6. runs authenticated Chrome/CDP acceptance for Meetings, Outreach, Reports, and Integrations;
7. requires a live Clerk session, nonempty application content, unchanged routes, and observed `/api/engagement` traffic exclusively to the main API;
8. proves no traffic reaches `4500` and no preview header or preview URL is present;
9. enumerates safe reads from the accepted route manifest and compares normalized status, content type, body, identity, and service header;
10. proves exact missing-token, invalid-token, wrong-tenant, below-role, unknown-role, cross-user, and cross-tenant denials;
11. creates a safe meeting through `engagement-api`, reads and updates it through the main API, then reads it back through `engagement-api`;
12. probes every controller/handler entry in the runtime registry, including both Microsoft and Google routes, and requires the stable `503 ENGAGEMENT_EXTERNAL_ACTION_DISABLED` response;
13. proves protected table digests do not change during external-action probes;
14. waits at least 65 seconds, verifies every worker-disabled log marker, and proves all Engagement-owned table digests remain unchanged;
15. builds and inspects the dedicated host image;
16. proves `migrate` and an unknown verb exit `64`;
17. builds and inspects the Linux ARM64 OCI artifact;
18. writes NC1–NC8 evidence;
19. tears down all child processes and the disposable database even on failure.

Expected terminal marker:

```text
ENGAGEMENT_PHASE1_LOCAL_COMPLETE
```

## Evidence

Evidence is written to:

```text
.artifacts/engagement-phase1-<exact-head-sha>/
```

Required files:

```text
local-runner-summary.json
health.json
read-parity.json
auth-parity.json
local-write-interoperability.json
external-action-denials.json
background-containment.json
browser-parity.json
negative-controls.json
image-inspection.json
screenshots/
logs/
```

The runner scans required JSON evidence for bearer tokens, session cookies, Clerk secrets, and database connection strings. Review logs separately before sharing them; never commit `.artifacts/`.

## Merge gate

Phase 1 is ready for manual merge only when:

- the branch is zero commits behind current `main`;
- the PR is mergeable;
- both local completion markers pass on the exact PR head;
- the SHA in `local-runner-summary.json` equals the PR head;
- NC1–NC8 pass;
- no unresolved P0/P1 review finding exists;
- no migration, AWS, ALB, DNS, standalone-service deployment, production port-`4500` routing, or visible UI change is present.

GitHub Actions status is informational only and must not be represented as test evidence.

## Deployment boundary after merge

Deploy the existing Capiro application stack normally because shared API code and `main.ts` changed. Do **not** deploy the standalone `engagement-api` service in Phase 1.

Do not create or deploy an `engagement-api` ECS service, task definition, target group, listener rule, DNS record, service-discovery entry, or autoscaling policy. Do not route production traffic to port `4500`. Phase 1 has no database migration.

## Rollback

Phase 1 is additive. Before merge, stop the local `engagement-api` process/container and discard the branch. After a normal existing-stack deployment, application rollback is the prior known-good main API/web release; there is no Phase 1 database or standalone-service rollback.
