# engagement-api

Dedicated Docker image for the Capiro Engagement API (Phase 1 local runtime).

## What this is

A second NestJS process that runs the existing Engagement backend as a **shadow
clone** of the main API. It shares the same source tree (`apps/api/src`) and
the same database — it is a runtime extraction, not a source fork.

```
main API        http://127.0.0.1:4000   (main.ts → AppModule)
engagement-api  http://127.0.0.1:4500   (engagement-main.ts → EngagementApiAppModule)
web             http://127.0.0.1:5173   (unchanged, points to :4000 only)
```

## Shadow mode

The engagement-api process starts with all external actions, background
workers, callbacks, and Recall webhooks disabled. Config validation enforces
the shadow matrix:

```
CAPIRO_SERVICE_NAME=engagement-api
ENGAGEMENT_PROCESS_MODE=shadow
ENGAGEMENT_BACKGROUND_OWNER=disabled
ENGAGEMENT_EXTERNAL_ACTIONS=disabled
ENGAGEMENT_CALLBACKS_ENABLED=false
ENGAGEMENT_RECALL_WEBHOOK_ENABLED=false
```

Any armed value in combination with `CAPIRO_SERVICE_NAME=engagement-api`
fails boot with a field-specific message.

## Serve-only entrypoint

The image supports only `serve`. All other verbs (migrate, seed, sync-*,
diag-*) are refused with exit code 64.

```bash
docker run --rm capiro-engagement-api:phase1-local migrate
# exit 64
```

## Build

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

## Health

```bash
curl -i http://127.0.0.1:4500/health
```

Every response carries `X-Capiro-Service: engagement-api`.
