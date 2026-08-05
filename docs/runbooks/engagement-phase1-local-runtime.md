# Engagement Phase 1 Local Runtime — Merge Closeout

GitHub Actions are unavailable for this repository and are **not** an acceptance dependency. Phase 1 is accepted from one exact, clean local checkout using the repository-owned closeout commands below.

## Required environment

Docker, Docker Buildx, Chrome/Chromium, Node 20.16+, pnpm 9.12+, and a Clerk test actor are required.

Set either the Phase 1 names below or the equivalent `ENGAGEMENT_PHASE0_*` aliases:

```text
CLERK_SECRET_KEY
CLERK_JWT_ISSUER
ENGAGEMENT_PHASE1_CLERK_ORG_ID
ENGAGEMENT_PHASE1_USER_CLERK_ID
ENGAGEMENT_PHASE1_USER_EMAIL
ENGAGEMENT_PHASE1_USER_COOKIE
```

The cookie and derived bearer token are never written into the evidence bundle. The temporary token file is mode `0600` and deleted during cleanup.

## 1. DB-free closeout

```bash
pnpm verify:engagement-phase-1
```

This command performs the locked install, all five Prisma generations, Phase 0 manifest verification, exact route-policy and negative-control tests, worker/provider/bootstrap/health/entrypoint tests, both API builds, repository typecheck, web tests, web routing drift checks, and `git diff --check`.

Expected terminal marker:

```text
ENGAGEMENT_PHASE1_DB_FREE_COMPLETE
```

It does not connect to a database, AWS, OAuth, Recall, an AI provider, or an email provider.

## 2. Authoritative local closeout

From a clean checkout of the exact PR head:

```bash
pnpm verify:engagement-phase-1:local -- --sha "$(git rev-parse HEAD)"
```

The command fails rather than skips when authenticated browser credentials, Chrome, Docker, Buildx, or a required fixture are unavailable. It:

1. Runs the DB-free closeout.
2. Creates a disposable PostgreSQL 16 + pgvector database and applies the complete migration history.
3. Seeds synthetic Engagement fixtures.
4. Starts the main API on `4000`, engagement-api on `4500`, and the unchanged web app on `5173`.
5. Verifies health, exact shadow posture, `X-Capiro-Service`, and Recall `404`.
6. Runs the current Engagement Chrome/CDP acceptance at four viewports.
7. Records actual browser network requests and proves no traffic reaches `4500` and no preview header exists.
8. Enumerates safe reads from the accepted route manifest and compares normalized status, content type, body, identity, and service header.
9. Proves missing/invalid/wrong-tenant, below-role, unknown-role, cross-user, and cross-tenant denial parity.
10. Creates a safe meeting through engagement-api, reads and updates it through the main API, then reads it back through engagement-api.
11. Probes every registered runtime action and proves the stable `503 ENGAGEMENT_EXTERNAL_ACTION_DISABLED` result without protected-table mutation.
12. Proves all background workers are disabled and no worker-start log is present.
13. Builds and inspects the dedicated host image, refuses `migrate` and an unknown command with exit `64`, and builds/inspects an ARM64 OCI artifact.
14. Tears down all child processes and the disposable database.

Expected terminal marker:

```text
ENGAGEMENT_PHASE1_LOCAL_COMPLETE
```

Evidence is written to:

```text
.artifacts/engagement-phase1-<sha>/
```

The merge decision must use the SHA in `local-runner-summary.json`. A result from another SHA is not transferable.

## Merge gate

Phase 1 is ready for manual merge only when:

- the PR is mergeable against current `main`;
- both local markers pass on the exact PR head;
- `local-runner-summary.json` reports every gate true;
- no unresolved P0/P1 review finding exists;
- no migration, AWS, ALB, DNS, deployment, or visible UI change is present.

GitHub Actions status is informational only and must not be represented as test evidence.

## Rollback

Phase 1 is additive and local-only. Stop the engagement-api process/container and revert the PR. No database or infrastructure rollback is required because this phase adds no migration and performs no deployment.
