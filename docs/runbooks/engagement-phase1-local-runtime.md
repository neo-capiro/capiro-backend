# Engagement Phase 1 Local Runtime Runbook

## Prerequisites

1. Phase 0 must be accepted and pass: `pnpm verify:engagement-phase-0`
2. Docker (for the disposable database and image build)
3. Node 20.16+ and pnpm 9.12+

## DB-free verification

```bash
pnpm verify:engagement-phase-1
```

This runs:
- Phase 0 verifier
- Phase 1 test suite (runtime policy, route coverage, timer containment,
  external boundaries, app module, bootstrap, health, entrypoint tests)
- API build (produces both `dist/main.js` and `dist/engagement-main.js`)
- Static check: no web preview routing change

Does NOT connect to a database, call AWS, or call any external provider.

## Local two-process acceptance

```bash
pnpm verify:engagement-phase-1:local -- --sha "$(git rev-parse HEAD)"
```

This:
1. Starts a disposable pgvector PostgreSQL 16 container
2. Applies all API migrations
3. Seeds engagement fixtures
4. Starts the main API on :4000
5. Starts the engagement-api on :4500 (shadow mode)
6. Waits for both health endpoints
7. Runs read-parity tests
8. Runs external-action denial tests
9. Optionally runs browser parity (needs ENGAGEMENT_PHASE1_USER_COOKIE)
10. Tears everything down

Evidence is written to `.artifacts/engagement-phase1-<sha>/`.

## Docker image build

```bash
docker build \
  -f apps/engagement-api/Dockerfile \
  -t capiro-engagement-api:phase1-local \
  .
```

## ARM64 artifact

```bash
mkdir -p .artifacts/engagement-phase1-image

docker buildx build \
  --platform linux/arm64 \
  -f apps/engagement-api/Dockerfile \
  --output type=oci,dest=.artifacts/engagement-phase1-image/engagement-api-arm64.oci.tar \
  .
```

## Verify image is serve-only

```bash
docker run --rm capiro-engagement-api:phase1-local migrate
# Expected: exit 64
```

## Manual testing

### Both processes run

```bash
curl -i http://127.0.0.1:4000/health
curl -i http://127.0.0.1:4500/health
```

### Shadow cannot act externally

Attempt any external action on :4500:
- connect Microsoft/Google
- sync
- dispatch notetaker
- generate
- send

Expected: `503 ENGAGEMENT_EXTERNAL_ACTION_DISABLED`

## Rollback

1. Stop the engagement-api process/container.
2. Delete local image/artifacts if desired.
3. Revert the Phase 1 branch/PR.
4. Continue running the unchanged main API and web app.
5. Dispose of the local test database (no migration exists).

No production rollback action is required because production was not changed.
